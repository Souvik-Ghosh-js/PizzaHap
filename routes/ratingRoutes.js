// ratingRoutes.js
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { submitRating, getProductRatings } = require('../controllers/miscController');
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

router.post('/', authenticate, [
  body('order_id').isInt(),
  body('product_id').isInt(),
  body('rating').isInt({ min: 1, max: 5 }),
], validate, submitRating);
router.get('/product/:id', getProductRatings);

module.exports = router;
