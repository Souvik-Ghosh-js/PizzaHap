const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  adminLogin, getDashboard, getReports,
  adminGetOrders, updateOrderStatus,
  adminGetUsers, blockUser,
  createProduct, updateProduct, deleteProduct,
  createCoupon, getAdminLocations,
} = require('../controllers/adminController');
const { getAllRefunds, processRefund } = require('../controllers/refundController');
const { adminGetAllTickets, adminReplyTicket } = require('../controllers/supportController');
const { uploadProductImage: uploadMiddleware } = require('../middlewares/upload');
const { uploadProductImage, setProductLocationAvailability, getProductLocationOverrides } = require('../controllers/menuController');
const { generateInvoice } = require('../controllers/miscController');
const { authenticateAdmin, requireRole } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

// ─── PUBLIC ───────────────────────────────────────────────────────
router.post('/auth/login', [
  body('email').isEmail(),
  body('password').notEmpty(),
], validate, adminLogin);

// All routes below require admin JWT
router.use(authenticateAdmin);

// ─── LOCATIONS ────────────────────────────────────────────────────
router.get('/locations', getAdminLocations);

// ─── DASHBOARD ────────────────────────────────────────────────────
router.get('/dashboard', getDashboard);
router.get('/dashboard/reports', getReports);

// ─── ORDERS ───────────────────────────────────────────────────────
router.get('/orders', adminGetOrders);
router.put('/orders/:id/status', [body('status').notEmpty()], validate, updateOrderStatus);
router.get('/orders/:id/invoice', generateInvoice);

// ─── USERS ────────────────────────────────────────────────────────
router.get('/users', adminGetUsers);
router.put('/users/:id/block', requireRole('super_admin', 'admin'), blockUser);

// ─── MENU ─────────────────────────────────────────────────────────
router.post('/menu/products', requireRole('super_admin', 'admin'), [
  body('name').trim().notEmpty(),
  body('base_price').isNumeric(),
  body('category_id').isInt(),
], validate, createProduct);
router.put('/menu/products/:id', requireRole('super_admin', 'admin'), updateProduct);
router.delete('/menu/products/:id', requireRole('super_admin', 'admin'), deleteProduct);

// Product image upload — multipart/form-data, field name: "image"
router.post(
  '/menu/products/:id/image',
  requireRole('super_admin', 'admin'),
  uploadMiddleware.single('image'),
  uploadProductImage
);

// Location-level product availability toggle
router.post('/menu/location-availability', requireRole('super_admin', 'admin'), [
  body('product_id').isInt(),
  body('location_id').isInt(),
  body('is_available').isBoolean(),
], validate, setProductLocationAvailability);
router.get('/menu/location-overrides', getProductLocationOverrides);

// ─── COUPONS ──────────────────────────────────────────────────────
router.post('/coupons', requireRole('super_admin', 'admin'), [
  body('code').trim().notEmpty(),
  body('discount_type').isIn(['percentage', 'flat']),
  body('discount_value').isNumeric(),
  body('valid_from').isISO8601(),
  body('valid_until').isISO8601(),
], validate, createCoupon);

// ─── REFUNDS ──────────────────────────────────────────────────────
router.get('/refunds', getAllRefunds);
router.post('/refunds/:id/process', requireRole('super_admin', 'admin'), processRefund);

// ─── SUPPORT ──────────────────────────────────────────────────────
router.get('/support/tickets', adminGetAllTickets);
router.post('/support/tickets/:id/reply', [
  body('message').trim().notEmpty(),
], validate, adminReplyTicket);

module.exports = router;
