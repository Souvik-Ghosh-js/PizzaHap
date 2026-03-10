const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { sendMobileOTP, resendMobileOTP, verifyMobileOTP, normalizeMobile } = require('../services/otpService');
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

const sendOTP = async (req, res, next) => {
  try {
    const { mobile } = req.body;
    const result = await sendMobileOTP(mobile);
    if (!result.success) return badRequest(res, result.message || 'Failed to send OTP');
    return success(res, {}, `OTP sent to ${normalizeMobile(mobile).replace(/(\d{2})\d{6}(\d{2})/, '$1xxxxxx$2')}`);
  } catch (err) { next(err); }
};

const resendOTP = async (req, res, next) => {
  try {
    const { mobile, type = 'text' } = req.body;
    const result = await resendMobileOTP(mobile, type);
    if (!result.success) return badRequest(res, result.message || 'Failed to resend OTP');
    return success(res, {}, 'OTP resent successfully');
  } catch (err) { next(err); }
};

const register = async (req, res, next) => {
  try {
    const { name, mobile, otp, email } = req.body;
    const normalizedMobile = normalizeMobile(mobile);

    const otpResult = await verifyMobileOTP(mobile, otp);
    if (!otpResult.valid) return badRequest(res, otpResult.reason || 'Invalid or expired OTP');

    const existing = await query(`SELECT id FROM Users WHERE mobile = ?`, [normalizedMobile]);
    if (existing.length) return conflict(res, 'Mobile number already registered. Please login.');

    if (email) {
      const emailCheck = await query(`SELECT id FROM Users WHERE email = ?`, [email]);
      if (emailCheck.length) return conflict(res, 'Email already in use.');
    }

    const result = await query(
      `INSERT INTO Users (name, mobile, email, is_verified) VALUES (?, ?, ?, 1)`,
      [name, normalizedMobile, email || null]
    );
    const user = { id: result.insertId, name, mobile: normalizedMobile, email };

    const { accessToken, refreshToken } = generateTokens(user.id);
    await saveRefreshToken(user.id, refreshToken);

    logger.info(`New user registered: ${normalizedMobile}`);
    return created(res, { user, accessToken, refreshToken }, 'Registration successful');
  } catch (err) { next(err); }
};

const login = async (req, res, next) => {
  try {
    const { mobile, otp } = req.body;
    const normalizedMobile = normalizeMobile(mobile);

    const otpResult = await verifyMobileOTP(mobile, otp);
    if (!otpResult.valid) return badRequest(res, otpResult.reason || 'Invalid or expired OTP');

    const result = await query(
      `SELECT id, name, email, mobile, is_verified, is_active, is_blocked FROM Users WHERE mobile = ?`,
      [normalizedMobile]
    );
    if (!result.length) return notFound(res, 'Mobile number not registered. Please register first.');

    const user = result[0];
    if (user.is_blocked) return unauthorized(res, 'Account blocked. Please contact support.');
    if (!user.is_active) return unauthorized(res, 'Account deactivated. Please contact support.');

    await query(`UPDATE Users SET last_login = NOW() WHERE id = ?`, [user.id]);

    const { accessToken, refreshToken } = generateTokens(user.id);
    await saveRefreshToken(user.id, refreshToken);

    logger.info(`User logged in: ${normalizedMobile}`);
    return success(res, { user, accessToken, refreshToken }, 'Login successful');
  } catch (err) { next(err); }
};

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

const logout = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (token) await query(`DELETE FROM RefreshTokens WHERE token = ?`, [token]);
    return success(res, {}, 'Logged out successfully');
  } catch (err) { next(err); }
};

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

const updateProfile = async (req, res, next) => {
  try {
    const { name, email, address, latitude, longitude, preferred_location_id } = req.body;
    await query(
      `UPDATE Users SET
        name = IFNULL(?, name),
        email = IFNULL(?, email),
        address = IFNULL(?, address),
        latitude = IFNULL(?, latitude),
        longitude = IFNULL(?, longitude),
        preferred_location_id = IFNULL(?, preferred_location_id),
        updated_at = NOW()
       WHERE id = ?`,
      [name || null, email || null, address || null, latitude || null, longitude || null, preferred_location_id || null, req.user.id]
    );
    return success(res, {}, 'Profile updated');
  } catch (err) { next(err); }
};

module.exports = { sendOTP, resendOTP, register, login, refreshToken, logout, getMe, updateProfile };
