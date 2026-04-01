const express = require('express');
const router = express.Router();
const { initiateOnlinePayment, createPaymentOrder, verifyPayment, handleWebhook } = require('../controllers/paymentController');
const { authenticate } = require('../middlewares/auth');

router.post('/initiate', authenticate, initiateOnlinePayment);
router.post('/create-order', authenticate, createPaymentOrder);
router.post('/verify', authenticate, verifyPayment);

// PayU posts to surl/furl — accepts both paths
// Configure your PayU dashboard surl/furl as: https://yourdomain.com/api/payments/payu-webhook
router.post('/payu-webhook', express.urlencoded({ extended: true }), handleWebhook);
router.post('/razorpay-webhook', express.urlencoded({ extended: true }), handleWebhook); // legacy alias

// Result page — WebView redirects here after PayU surl/furl processing
router.get('/result', (req, res) => {
  const { status, order_id } = req.query;
  const isSuccess = status === 'success';
  res.send(`<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: ${isSuccess ? '#f0fdf4' : '#fef2f2'}; }
      .card { text-align: center; padding: 2rem; }
      .icon { font-size: 4rem; }
      h2 { color: ${isSuccess ? '#16a34a' : '#dc2626'}; }
      p { color: #666; }
    </style>
  </head><body>
    <div class="card">
      <div class="icon">${isSuccess ? '&#10004;' : '&#10008;'}</div>
      <h2>${isSuccess ? 'Payment Successful!' : 'Payment Failed'}</h2>
      <p>${isSuccess ? 'Your order has been confirmed.' : 'Please try again from My Orders.'}</p>
      <p style="font-size:0.8rem;color:#999;">Returning to app...</p>
    </div>
  </body></html>`);
});

module.exports = router;