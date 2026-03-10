const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { validateCoupon, getActiveCoupons } = require('../controllers/miscController');
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

router.get('/', authenticate, getActiveCoupons);
router.post('/validate', authenticate, [
  body('code').trim().notEmpty(),
  body('order_value').isNumeric(),
], validate, validateCoupon);

module.exports = router;
