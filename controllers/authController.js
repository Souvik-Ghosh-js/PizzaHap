const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { sendEmailOTP, resendEmailOTP, verifyEmailOTP, normalizeEmail } = require('../services/otpService');
const { success, created, badRequest, unauthorized, conflict, notFound } = require('../utils/response');
const logger = require('../utils/logger');

const generateTokens = (userId) => {
  const accessToken = jwt.sign({ id: userId, type: 'user' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
  const refreshToken = jwt.sign({ id: userId, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
  return { accessToken, refreshToken };
};

const saveRefreshToken = async (userId, refreshToken) => {
  const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO RefreshTokens (user_id, token, expires_at) VALUES (?, ?, ?)`,
    [userId, refreshToken, refreshExpiry]
  );
};

// ─── MASK EMAIL FOR RESPONSE ──────────────────────────────────────
// e.g. "us****@gmail.com"
const maskEmail = (email) => {
  const [local, domain] = email.split('@');
  const visible = local.slice(0, 2);
  return `${visible}****@${domain}`;
};

// POST /auth/send-otp
// Body: { email }
const sendOTP = async (req, res, next) => {
  try {
    const { email } = req.body;
    const result = await sendEmailOTP(email);
    if (!result.success) return badRequest(res, result.message || 'Failed to send OTP');
    return success(res, {}, `OTP sent to ${maskEmail(normalizeEmail(email))}`);
  } catch (err) { next(err); }
};

// POST /auth/resend-otp
// Body: { email }
const resendOTP = async (req, res, next) => {
  try {
    const { email } = req.body;
    const result = await resendEmailOTP(email);
    if (!result.success) return badRequest(res, result.message || 'Failed to resend OTP');
    return success(res, {}, 'OTP resent successfully');
  } catch (err) { next(err); }
};

// POST /auth/register
// Body: { name, email, otp, mobile? }
const register = async (req, res, next) => {
  try {
    const { name, email, otp, mobile } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const otpResult = await verifyEmailOTP(email, otp);
    if (!otpResult.valid) return badRequest(res, otpResult.reason || 'Invalid or expired OTP');

    const existing = await query(`SELECT id FROM Users WHERE email = ?`, [normalizedEmail]);
    if (existing.length) return conflict(res, 'Email already registered. Please login.');

    const result = await query(
      `INSERT INTO Users (name, email, mobile, is_verified) VALUES (?, ?, ?, 1)`,
      [name, normalizedEmail, mobile || null]
    );
    const user = { id: result.insertId, name, email: normalizedEmail, mobile: mobile || null };

    const { accessToken, refreshToken } = generateTokens(user.id);
    await saveRefreshToken(user.id, refreshToken);

    logger.info(`New user registered: ${normalizedEmail}`);
    return created(res, { user, accessToken, refreshToken }, 'Registration successful');
  } catch (err) { next(err); }
};

// POST /auth/login
// Body: { email, otp }
const login = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const otpResult = await verifyEmailOTP(email, otp);
    if (!otpResult.valid) return badRequest(res, otpResult.reason || 'Invalid or expired OTP');

    const result = await query(
      `SELECT id, name, email, mobile, is_verified, is_active, is_blocked FROM Users WHERE email = ?`,
      [normalizedEmail]
    );
    if (!result.length) return notFound(res, 'Email not registered. Please register first.');

    const user = result[0];
    if (user.is_blocked) return unauthorized(res, 'Account blocked. Please contact support.');
    if (!user.is_active) return unauthorized(res, 'Account deactivated. Please contact support.');

    await query(`UPDATE Users SET last_login = NOW() WHERE id = ?`, [user.id]);

    const { accessToken, refreshToken } = generateTokens(user.id);
    await saveRefreshToken(user.id, refreshToken);

    logger.info(`User logged in: ${normalizedEmail}`);
    return success(res, { user, accessToken, refreshToken }, 'Login successful');
  } catch (err) { next(err); }
};

// POST /auth/refresh-token
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return badRequest(res, 'Refresh token required');

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const result = await query(
      `SELECT * FROM RefreshTokens WHERE token = ? AND user_id = ? AND expires_at > NOW()`,
      [token, decoded.id]
    );
    if (!result.length) return unauthorized(res, 'Invalid or expired refresh token');

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(decoded.id);
    await query(`DELETE FROM RefreshTokens WHERE token = ?`, [token]);
    await saveRefreshToken(decoded.id, newRefreshToken);

    return success(res, { accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return unauthorized(res, 'Invalid refresh token');
    next(err);
  }
};

// POST /auth/logout
const logout = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (token) await query(`DELETE FROM RefreshTokens WHERE token = ?`, [token]);
    return success(res, {}, 'Logged out successfully');
  } catch (err) { next(err); }
};

// GET /auth/me  (protected)
const getMe = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email, u.mobile, u.profile_picture, u.address,
              u.latitude, u.longitude, u.preferred_location_id, u.created_at,
              l.name as preferred_location_name
       FROM Users u
       LEFT JOIN Locations l ON u.preferred_location_id = l.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    return success(res, result[0]);
  } catch (err) { next(err); }
};

// PUT /auth/profile  (protected)
const updateProfile = async (req, res, next) => {
  try {
    const { name, mobile, address, latitude, longitude, preferred_location_id } = req.body;
    await query(
      `UPDATE Users SET
        name = IFNULL(?, name),
        mobile = IFNULL(?, mobile),
        address = IFNULL(?, address),
        latitude = IFNULL(?, latitude),
        longitude = IFNULL(?, longitude),
        preferred_location_id = IFNULL(?, preferred_location_id),
        updated_at = NOW()
       WHERE id = ?`,
      [name || null, mobile || null, address || null, latitude || null, longitude || null, preferred_location_id || null, req.user.id]
    );
    return success(res, {}, 'Profile updated');
  } catch (err) { next(err); }
};

module.exports = { sendOTP, resendOTP, register, login, refreshToken, logout, getMe, updateProfile };