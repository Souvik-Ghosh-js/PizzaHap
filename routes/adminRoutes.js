const express = require('express');
const router  = express.Router();
const path    = require('path');
const multer  = require('multer');
const { body } = require('express-validator');
const {
  adminLogin, getDashboard, getReports,
  adminGetOrders, updateOrderStatus,
  adminGetUsers, blockUser,
  adminGetProducts, createProduct, updateProduct, deleteProduct,
  uploadProductImage, setProductLocationAvailability, getProductAvailabilityMatrix,
  createCoupon,
} = require('../controllers/adminController');
const { getAllRefunds, processRefund } = require('../controllers/refundController');
const { adminGetAllTickets, adminReplyTicket } = require('../controllers/supportController');
const { authenticateAdmin, requireRole } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');
const { generateInvoice } = require('../controllers/miscController');

// ── Image upload via multer ────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/products/'),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `product_${req.params.id}_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|webp/.test(path.extname(file.originalname).toLowerCase()) &&
               /jpeg|jpg|png|webp|image/.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only JPEG, PNG, WebP images allowed'));
  },
});

// ── Public ────────────────────────────────────────────────────────
router.post('/auth/login', [
  body('email').isEmail(),
  body('password').notEmpty(),
], validate, adminLogin);

// ── Protected ─────────────────────────────────────────────────────
router.use(authenticateAdmin);

// Dashboard
router.get('/dashboard',         getDashboard);
router.get('/dashboard/reports', getReports);

// Orders
router.get('/orders',                 adminGetOrders);
router.put('/orders/:id/status', [body('status').notEmpty()], validate, updateOrderStatus);
router.get('/orders/:id/invoice',     generateInvoice);

// Users
router.get('/users',           adminGetUsers);
router.put('/users/:id/block', requireRole('super_admin','admin'), blockUser);

// Menu — admin sees ALL products (including unavailable) so they can re-enable them
router.get('/menu/products',                                     adminGetProducts);
router.post('/menu/products',    requireRole('super_admin','admin'), [
  body('name').trim().notEmpty(),
  body('base_price').isNumeric(),
  body('category_id').isInt(),
], validate, createProduct);
router.put('/menu/products/:id',   requireRole('super_admin','admin'), updateProduct);
router.delete('/menu/products/:id',requireRole('super_admin','admin'), deleteProduct);
router.post('/menu/products/:id/image',
  requireRole('super_admin','admin'), upload.single('image'), uploadProductImage);

// Per-location availability
router.put('/menu/products/:id/location-availability',
  requireRole('super_admin','admin','staff'), setProductLocationAvailability);
router.get('/menu/products/:id/availability-matrix',
  getProductAvailabilityMatrix);

// Coupons
router.post('/coupons', requireRole('super_admin','admin'), [
  body('code').trim().notEmpty(),
  body('discount_type').isIn(['percentage','flat']),
  body('discount_value').isNumeric(),
  body('valid_from').isISO8601(),
  body('valid_until').isISO8601(),
], validate, createCoupon);

// Refunds
router.get('/refunds',                  getAllRefunds);
router.post('/refunds/:id/process',     requireRole('super_admin','admin'), processRefund);

// Support
router.get('/support/tickets',          adminGetAllTickets);
router.post('/support/tickets/:id/reply',
  [body('message').trim().notEmpty()], validate, adminReplyTicket);

module.exports = router;
