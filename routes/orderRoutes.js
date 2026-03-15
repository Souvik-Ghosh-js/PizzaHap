const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  calculateOrder, placeOrder, getMyOrders, getOrderById,
  cancelOrder, reorder, submitOrderFeedback, getMyCoinBalance,
} = require('../controllers/orderController');
const { generateInvoice } = require('../controllers/miscController');
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

router.post('/calculate', authenticate, calculateOrder);

router.post('/', authenticate, [
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('location_id').isInt().withMessage('Location required'),
  body('payment_method').optional().isIn(['online', 'cash_on_delivery']),
  body('coins_to_redeem').optional().isInt({ min: 0 }),
], validate, placeOrder);

router.get('/coins', authenticate, getMyCoinBalance);
router.get('/', authenticate, getMyOrders);
router.get('/:id', authenticate, getOrderById);
router.get('/:id/invoice', authenticate, generateInvoice);

router.post('/:id/cancel', authenticate, [
  body('reason').optional().trim(),
], validate, cancelOrder);

router.post('/:id/reorder', authenticate, reorder);

router.post('/:id/feedback', authenticate, [
  body('food_rating').isInt({ min: 1, max: 5 }),
  body('overall_rating').isInt({ min: 1, max: 5 }),
  body('delivery_rating').optional().isInt({ min: 1, max: 5 }),
  body('comment').optional().trim(),
], validate, submitOrderFeedback);

module.exports = router;
