const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { calculateOrder, placeOrder, getMyOrders, getOrderById, cancelOrder, reorder } = require('../controllers/orderController');
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

router.post('/calculate', authenticate, calculateOrder);
router.post('/', authenticate, [
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('location_id').isInt().withMessage('Location required'),
], validate, placeOrder);
router.get('/', authenticate, getMyOrders);
router.get('/:id', authenticate, getOrderById);
router.post('/:id/cancel', authenticate, [
  body('reason').optional().trim(),
], validate, cancelOrder);
router.post('/:id/reorder', authenticate, reorder);

module.exports = router;
