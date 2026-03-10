const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  adminLogin, getDashboard, getReports,
  adminGetOrders, updateOrderStatus,
  adminGetUsers, blockUser,
  createProduct, updateProduct, deleteProduct,
  createCoupon,
} = require('../controllers/adminController');
const { getAllRefunds, processRefund } = require('../controllers/refundController');
const { adminGetAllTickets, adminReplyTicket } = require('../controllers/supportController');
const { authenticateAdmin, requireRole } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

// Public admin auth
router.post('/auth/login', [
  body('email').isEmail(),
  body('password').notEmpty(),
], validate, adminLogin);

// Protected admin routes
router.use(authenticateAdmin);

// Dashboard
router.get('/dashboard', getDashboard);
router.get('/dashboard/reports', getReports);

// Order management
router.get('/orders', adminGetOrders);
router.put('/orders/:id/status', [
  body('status').notEmpty(),
], validate, updateOrderStatus);

// Invoice (admin view)
const { generateInvoice } = require('../controllers/miscController');
router.get('/orders/:id/invoice', generateInvoice);

// User management
router.get('/users', adminGetUsers);
router.put('/users/:id/block', requireRole('super_admin', 'admin'), blockUser);

// Menu management
router.post('/menu/products', requireRole('super_admin', 'admin'), [
  body('name').trim().notEmpty(),
  body('base_price').isNumeric(),
  body('category_id').isInt(),
], validate, createProduct);
router.put('/menu/products/:id', requireRole('super_admin', 'admin'), updateProduct);
router.delete('/menu/products/:id', requireRole('super_admin', 'admin'), deleteProduct);

// Coupons
router.post('/coupons', requireRole('super_admin', 'admin'), [
  body('code').trim().notEmpty(),
  body('discount_type').isIn(['percentage', 'flat']),
  body('discount_value').isNumeric(),
  body('valid_from').isISO8601(),
  body('valid_until').isISO8601(),
], validate, createCoupon);

// Refunds
router.get('/refunds', getAllRefunds);
router.post('/refunds/:id/process', requireRole('super_admin', 'admin'), processRefund);

// Support
router.get('/support/tickets', adminGetAllTickets);
router.post('/support/tickets/:id/reply', [
  body('message').trim().notEmpty(),
], validate, adminReplyTicket);

module.exports = router;
