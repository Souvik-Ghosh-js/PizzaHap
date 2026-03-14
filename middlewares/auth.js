const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { unauthorized, forbidden } = require('../utils/response');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return unauthorized(res, 'Access token required');

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query(
      `SELECT id, name, email, mobile, is_active, is_blocked FROM Users WHERE id = ?`,
      [decoded.id]
    );
    if (!result.length) return unauthorized(res, 'User not found');
    const user = result[0];
    if (!user.is_active) return forbidden(res, 'Account deactivated');
    if (user.is_blocked) return forbidden(res, 'Account blocked. Contact support.');

    req.user = { ...user, role: 'user' };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Token expired');
    return unauthorized(res, 'Invalid token');
  }
};

const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return unauthorized(res, 'Access token required');

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'admin') return forbidden(res, 'Admin access only');

    const result = await query(
      `SELECT id, name, email, role, location_id, is_active FROM Admins WHERE id = ?`,
      [decoded.id]
    );
    if (!result.length) return unauthorized(res, 'Admin not found');
    const admin = result[0];
    if (!admin.is_active) return forbidden(res, 'Admin account deactivated');

    // Use location_id from JWT token (set at login time, may be overridden for super_admin)
    req.admin = { ...admin, location_id: decoded.location_id || admin.location_id || null };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Token expired');
    return unauthorized(res, 'Invalid token');
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.admin || !roles.includes(req.admin.role)) return forbidden(res, 'Insufficient permissions');
  next();
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query(`SELECT id, name, email FROM Users WHERE id = ? AND is_active = 1`, [decoded.id]);
      if (result.length) req.user = result[0];
    }
  } catch (_) { /* optional */ }
  next();
};

module.exports = { authenticate, authenticateAdmin, requireRole, optionalAuth };
