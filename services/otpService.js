const axios = require('axios');
const { query, sql } = require('../config/db');
const logger = require('../utils/logger');

// ─── MSG91 CONFIG ─────────────────────────────────────────────────
// MSG91 sends and verifies OTP on their end.
// We also store OTP locally in DB as a fallback for retries/audit.
const MSG91_BASE = 'https://control.msg91.com/api/v5';
const getHeaders = () => ({
  authkey: process.env.MSG91_AUTH_KEY,
  'Content-Type': 'application/json',
});

// Normalize mobile to 10-digit (strip +91 or 91 prefix if present)
const normalizeMobile = (mobile) => {
  const stripped = mobile.replace(/\D/g, ''); // remove non-digits
  if (stripped.length === 12 && stripped.startsWith('91')) return stripped.slice(2);
  if (stripped.length === 10) return stripped;
  return stripped;
};

// Full mobile with country code for MSG91 (needs 91XXXXXXXXXX)
const toMsg91Format = (mobile) => `91${normalizeMobile(mobile)}`;

// ─── GENERATE OTP ─────────────────────────────────────────────────
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ─── STORE OTP IN DB ──────────────────────────────────────────────
const storeOTP = async (mobile, otp, type = 'mobile_verification') => {
  const expiresAt = new Date(Date.now() + parseInt(process.env.OTP_EXPIRY_MINUTES || 10) * 60 * 1000);
  const identifier = normalizeMobile(mobile);

  // Invalidate any existing unused OTPs for this mobile+type
  await query(
    `UPDATE OtpTokens SET is_used = 1 WHERE identifier = @identifier AND type = @type AND is_used = 0`,
    {
      identifier: { type: sql.NVarChar, value: identifier },
      type: { type: sql.NVarChar, value: type },
    }
  );

  await query(
    `INSERT INTO OtpTokens (identifier, otp, type, expires_at) VALUES (@identifier, @otp, @type, @expiresAt)`,
    {
      identifier: { type: sql.NVarChar, value: identifier },
      otp: { type: sql.NVarChar, value: otp },
      type: { type: sql.NVarChar, value: type },
      expiresAt: { type: sql.DateTime, value: expiresAt },
    }
  );
};

// ─── SEND OTP VIA MSG91 ───────────────────────────────────────────
// MSG91 sends the SMS directly using your DLT-approved template.
// The OTP is generated here and passed to MSG91.
const sendMobileOTP = async (mobile) => {
  try {
    const otp = generateOTP();
    const msg91Mobile = toMsg91Format(mobile);

    const response = await axios.post(
      `${MSG91_BASE}/otp`,
      {
        mobile: msg91Mobile,
        otp,
        template_id: process.env.MSG91_TEMPLATE_ID,
        otp_expiry: parseInt(process.env.OTP_EXPIRY_MINUTES || 10),
        otp_length: 6,
        sender: process.env.MSG91_SENDER_ID || 'GOBTPZ',
      },
      { headers: getHeaders() }
    );

    if (response.data?.type === 'error') {
      logger.error(`MSG91 send error for ${mobile}: ${JSON.stringify(response.data)}`);
      return { success: false, message: response.data.message };
    }

    // Store in DB for audit + fallback verification
    await storeOTP(mobile, otp, 'mobile_verification');

    logger.info(`OTP sent via MSG91 to ${mobile}`);
    return { success: true };
  } catch (err) {
    logger.error(`MSG91 sendOTP failed for ${mobile}: ${err.message}`);
    return { success: false, message: 'Failed to send OTP. Please try again.' };
  }
};

// ─── RESEND OTP VIA MSG91 ─────────────────────────────────────────
const resendMobileOTP = async (mobile, retryType = 'text') => {
  // retryType options: 'text' | 'voice'
  try {
    const msg91Mobile = toMsg91Format(mobile);

    const response = await axios.get(
      `${MSG91_BASE}/otp/retry`,
      {
        params: { mobile: msg91Mobile, retrytype: retryType },
        headers: getHeaders(),
      }
    );

    if (response.data?.type === 'error') {
      return { success: false, message: response.data.message };
    }

    logger.info(`OTP resent to ${mobile} via ${retryType}`);
    return { success: true };
  } catch (err) {
    logger.error(`MSG91 resendOTP failed for ${mobile}: ${err.message}`);
    return { success: false, message: 'Failed to resend OTP.' };
  }
};

// ─── VERIFY OTP ───────────────────────────────────────────────────
// Primary: verify via MSG91 API
// Fallback: verify against local DB (handles edge cases / network issues)
const verifyMobileOTP = async (mobile, otp) => {
  const identifier = normalizeMobile(mobile);

  // ── Check attempt limit in DB first ──
  const dbRecord = await query(
    `SELECT TOP 1 * FROM OtpTokens
     WHERE identifier = @identifier AND type = 'mobile_verification' AND is_used = 0
     ORDER BY created_at DESC`,
    { identifier: { type: sql.NVarChar, value: identifier } }
  );

  if (dbRecord.recordset.length && dbRecord.recordset[0].attempts >= 5) {
    return { valid: false, reason: 'Too many attempts. Please request a new OTP.' };
  }

  // ── Primary: MSG91 verify ──
  try {
    const msg91Mobile = toMsg91Format(mobile);
    const response = await axios.get(
      `${MSG91_BASE}/otp/verify`,
      {
        params: { mobile: msg91Mobile, otp },
        headers: getHeaders(),
      }
    );

    if (response.data?.type === 'success') {
      // Mark DB record as used on success
      await query(
        `UPDATE OtpTokens SET is_used = 1
         WHERE identifier = @identifier AND type = 'mobile_verification' AND is_used = 0`,
        { identifier: { type: sql.NVarChar, value: identifier } }
      );
      logger.info(`OTP verified via MSG91 for ${mobile}`);
      return { valid: true };
    }

    // MSG91 returned error — increment attempt
    await incrementOTPAttempt(mobile);
    logger.warn(`MSG91 OTP verify failed for ${mobile}: ${JSON.stringify(response.data)}`);
    return { valid: false, reason: 'Invalid OTP' };

  } catch (err) {
    logger.error(`MSG91 verify API error for ${mobile}: ${err.message}. Falling back to DB.`);

    // ── Fallback: verify against local DB ──
    return await verifyOTPFromDB(mobile, otp);
  }
};

// ─── DB FALLBACK VERIFY ───────────────────────────────────────────
const verifyOTPFromDB = async (mobile, otp) => {
  const identifier = normalizeMobile(mobile);

  const result = await query(
    `SELECT * FROM OtpTokens
     WHERE identifier = @identifier AND otp = @otp AND type = 'mobile_verification'
       AND is_used = 0 AND expires_at > GETDATE()
     ORDER BY created_at DESC`,
    {
      identifier: { type: sql.NVarChar, value: identifier },
      otp: { type: sql.NVarChar, value: otp },
    }
  );

  if (!result.recordset.length) {
    await incrementOTPAttempt(mobile);
    return { valid: false, reason: 'Invalid or expired OTP' };
  }

  // Mark as used
  await query(
    `UPDATE OtpTokens SET is_used = 1 WHERE id = @id`,
    { id: { type: sql.Int, value: result.recordset[0].id } }
  );

  logger.info(`OTP verified via DB fallback for ${mobile}`);
  return { valid: true };
};

// ─── INCREMENT ATTEMPT ────────────────────────────────────────────
const incrementOTPAttempt = async (mobile) => {
  const identifier = normalizeMobile(mobile);
  await query(
    `UPDATE OtpTokens SET attempts = attempts + 1
     WHERE identifier = @identifier AND type = 'mobile_verification' AND is_used = 0`,
    { identifier: { type: sql.NVarChar, value: identifier } }
  );
};

// ─── SEND TRANSACTIONAL EMAIL (kept for invoices/notifications) ───
const sendEmail = async (to, subject, html) => {
  // Keep nodemailer for non-OTP emails if needed, or swap with any email provider
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"${process.env.APP_NAME}" <${process.env.GMAIL_USER}>`,
      to, subject, html,
    });
    return true;
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.message}`);
    return false;
  }
};

module.exports = {
  generateOTP,
  storeOTP,
  normalizeMobile,
  sendMobileOTP,
  resendMobileOTP,
  verifyMobileOTP,
  incrementOTPAttempt,
  sendEmail,
};