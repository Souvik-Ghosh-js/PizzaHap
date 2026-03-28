const nodemailer = require('nodemailer');
const { query } = require('../config/db');
const logger = require('../utils/logger');

// ─── TRANSPORTER ──────────────────────────────────────────────────
const createTransporter = () =>
  nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

// ─── GENERATE OTP ─────────────────────────────────────────────────
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ─── NORMALIZE EMAIL ──────────────────────────────────────────────
const normalizeEmail = (email) => email.trim().toLowerCase();

// ─── STORE OTP IN DB ──────────────────────────────────────────────
const storeOTP = async (email, otp, type = 'email_verification') => {
  const expiresAt = new Date(
    Date.now() + parseInt(process.env.OTP_EXPIRY_MINUTES || 10) * 60 * 1000
  );
  const identifier = normalizeEmail(email);

  // Invalidate any existing unused OTPs for this email+type
  await query(
    `UPDATE OtpTokens SET is_used = 1 WHERE identifier = ? AND type = ? AND is_used = 0`,
    [identifier, type]
  );

  await query(
    `INSERT INTO OtpTokens (identifier, otp, type, expires_at) VALUES (?, ?, ?, ?)`,
    [identifier, otp, type, expiresAt]
  );
};

// ─── OTP EMAIL HTML TEMPLATE ──────────────────────────────────────
const buildOtpEmailHtml = (otp) => `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 32px; border: 1px solid #e5e7eb; border-radius: 8px;">
    <h2 style="color: #111827; margin-bottom: 8px;">Your OTP Code</h2>
    <p style="color: #6b7280; margin-bottom: 24px;">
      Use the code below to verify your account. It expires in
      <strong>${process.env.OTP_EXPIRY_MINUTES || 10} minutes</strong>.
    </p>
    <div style="font-size: 36px; font-weight: bold; letter-spacing: 12px; color: #1d4ed8; text-align: center; padding: 16px; background: #eff6ff; border-radius: 6px;">
      ${otp}
    </div>
    <p style="color: #9ca3af; font-size: 13px; margin-top: 24px;">
      If you did not request this, please ignore this email.
    </p>
  </div>
`;

// ─── SEND OTP VIA EMAIL ───────────────────────────────────────────
const sendEmailOTP = async (email) => {
  try {
    const otp = generateOTP();
    const transporter = createTransporter();

    await transporter.sendMail({
      from: `"${process.env.APP_NAME || 'App'}" <${process.env.GMAIL_USER}>`,
      to: normalizeEmail(email),
      subject: 'Your OTP Code',
      html: buildOtpEmailHtml(otp),
    });

    // Store in DB for verification
    await storeOTP(email, otp, 'email_verification');

    logger.info(`OTP sent via email to ${email}`);
    return { success: true };
  } catch (err) {
    logger.error(`sendEmailOTP failed for ${email}: ${err.message}`);
    return { success: false, message: 'Failed to send OTP. Please try again.' };
  }
};

// ─── RESEND OTP VIA EMAIL ─────────────────────────────────────────
// Simply sends a fresh OTP (storeOTP will invalidate the previous one)
const resendEmailOTP = async (email) => {
  return await sendEmailOTP(email);
};

// ─── VERIFY OTP FROM DB ───────────────────────────────────────────
const verifyEmailOTP = async (email, otp) => {
  const identifier = normalizeEmail(email);

  // ── Check attempt limit ──
  const [latestRecord] = await query(
    `SELECT * FROM OtpTokens
     WHERE identifier = ? AND type = 'email_verification' AND is_used = 0
     ORDER BY created_at DESC LIMIT 1`,
    [identifier]
  );

  if (!latestRecord) {
    return { valid: false, reason: 'No active OTP found. Please request a new one.' };
  }

  if (latestRecord.attempts >= 5) {
    return { valid: false, reason: 'Too many attempts. Please request a new OTP.' };
  }

  // ── Verify OTP and expiry ──
  const now = new Date();
  const isExpired = new Date(latestRecord.expires_at) < now;
  const isMatch = latestRecord.otp === otp.toString().trim();

  if (isExpired) {
    return { valid: false, reason: 'OTP has expired. Please request a new one.' };
  }

  if (!isMatch) {
    await incrementOTPAttempt(email);
    return { valid: false, reason: 'Invalid OTP. Please try again.' };
  }

  // ── Mark as used ──
  await query(`UPDATE OtpTokens SET is_used = 1 WHERE id = ?`, [latestRecord.id]);

  logger.info(`OTP verified for ${email}`);
  return { valid: true };
};

// ─── INCREMENT ATTEMPT ────────────────────────────────────────────
const incrementOTPAttempt = async (email) => {
  const identifier = normalizeEmail(email);
  await query(
    `UPDATE OtpTokens SET attempts = attempts + 1
     WHERE identifier = ? AND type = 'email_verification' AND is_used = 0`,
    [identifier]
  );
};

// ─── SEND TRANSACTIONAL EMAIL (non-OTP) ───────────────────────────
const sendEmail = async (to, subject, html) => {
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `"${process.env.APP_NAME}" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.message}`);
    return false;
  }
};

// ─── ORDER STATUS EMAIL ───────────────────────────────────────────
const sendOrderStatusEmail = async (to, orderNumber, status) => {
  const statusMessages = {
    delivered: 'Great news! Your order has been delivered. Enjoy your meal!',
    cancelled: 'Your order has been cancelled. If you have any questions, please contact support.',
  };
  const subject = `Update for your Order #${orderNumber}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 32px; border: 1px solid #e5e7eb; border-radius: 8px;">
      <h2 style="color: #111827; margin-bottom: 16px;">Order ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">Hello,</p>
      <p style="color: #4b5563; line-height: 1.6;">${statusMessages[status] || `Your order #${orderNumber} status changed to ${status}.`}</p>
      <div style="margin: 24px 0; padding: 16px; background: #f9fafb; border-radius: 6px; border: 1px solid #f3f4f6;">
        <span style="color: #6b7280; font-size: 14px;">Order Number:</span>
        <strong style="color: #111827; display: block; font-size: 18px;">${orderNumber}</strong>
      </div>
      <p style="color: #9ca3af; font-size: 13px; margin-top: 24px;">
        Thank you for choosing PizzaHap!
      </p>
    </div>
  `;
  return await sendEmail(to, subject, html);
};

// ─── RIDER ASSIGNMENT EMAIL ───────────────────────────────────────
const sendRiderAssignmentEmail = async (riderEmail, riderName, orderNumber, deliveryDetails) => {
  const subject = `New Order Assigned: #${orderNumber}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 32px; border: 1px solid #e5e7eb; border-radius: 8px;">
      <h2 style="color: #111827; margin-bottom: 16px;">New Order Assigned</h2>
      <p style="color: #4b5563; line-height: 1.6;">Hello ${riderName},</p>
      <p style="color: #4b5563; line-height: 1.6;">A new order has been assigned to you for delivery.</p>
      <div style="margin: 24px 0; padding: 16px; background: #fefce8; border-radius: 6px; border: 1px solid #fef9c3;">
        <strong style="color: #854d0e; display: block; margin-bottom: 8px;">Order Details:</strong>
        <p style="margin: 4px 0; color: #713f12;"><strong>Order:</strong> #${orderNumber}</p>
        <p style="margin: 4px 0; color: #713f12;"><strong>Address:</strong> ${deliveryDetails}</p>
      </div>
      <p style="color: #4b5563; line-height: 1.6;">Please proceed to the kitchen to pick up the order.</p>
    </div>
  `;
  return await sendEmail(riderEmail, subject, html);
};

module.exports = {
  generateOTP,
  storeOTP,
  normalizeEmail,
  sendEmailOTP,
  resendEmailOTP,
  verifyEmailOTP,
  incrementOTPAttempt,
  sendEmail,
  sendOrderStatusEmail,
  sendRiderAssignmentEmail,
};