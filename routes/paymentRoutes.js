const express = require('express');
const router = express.Router();
const { createPaymentOrder, verifyPayment, handleWebhook } = require('../controllers/paymentController');
const { authenticate } = require('../middlewares/auth');

router.post('/create-order', authenticate, createPaymentOrder);
router.post('/verify', authenticate, verifyPayment);

// PayU posts to surl/furl — accepts both paths
// Configure your PayU dashboard surl/furl as: https://yourdomain.com/api/payments/payu-webhook
router.post('/payu-webhook', express.urlencoded({ extended: true }), handleWebhook);
router.post('/razorpay-webhook', express.urlencoded({ extended: true }), handleWebhook); // legacy alias

module.exports = router;