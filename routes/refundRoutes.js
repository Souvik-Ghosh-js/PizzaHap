const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { requestRefund, getMyRefunds } = require('../controllers/refundController');
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

router.post('/request', authenticate, [
  body('order_id').isInt(),
  body('reason').trim().notEmpty(),
], validate, requestRefund);
router.get('/my-refunds', authenticate, getMyRefunds);

module.exports = router;
