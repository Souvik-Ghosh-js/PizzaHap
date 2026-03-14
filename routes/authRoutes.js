const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  sendOTP, resendOTP, register, login, refreshToken, logout, getMe, updateProfile,
} = require('../controllers/authController');
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

// Reusable validators
const emailValidator = body('email')
  .trim()
  .notEmpty().withMessage('Email is required')
  .isEmail().withMessage('Enter a valid email address')
  .normalizeEmail();

const otpValidator = body('otp')
  .trim()
  .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
  .isNumeric().withMessage('OTP must be numeric');

// POST /auth/send-otp
// Body: { email }
router.post('/send-otp', [emailValidator], validate, sendOTP);

// POST /auth/resend-otp
// Body: { email }
router.post('/resend-otp', [emailValidator], validate, resendOTP);

// POST /auth/register
// Body: { name, email, otp, mobile? }
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  emailValidator,
  otpValidator,
  body('mobile')
    .optional()
    .matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),
], validate, register);

// POST /auth/login
// Body: { email, otp }
router.post('/login', [emailValidator, otpValidator], validate, login);

// POST /auth/refresh-token
router.post('/refresh-token', [
  body('refreshToken').notEmpty().withMessage('Refresh token is required'),
], validate, refreshToken);

// POST /auth/logout
router.post('/logout', logout);

// GET /auth/me  (protected)
router.get('/me', authenticate, getMe);

// PUT /auth/profile  (protected)
router.put('/profile', authenticate, [
  body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
  body('mobile')
    .optional()
    .matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),
  body('preferred_location_id').optional().isInt().withMessage('Invalid location ID'),
], validate, updateProfile);

module.exports = router;