const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../config/db');
const { success, created, badRequest, notFound } = require('../utils/response');
const logger = require('../utils/logger');

const PAYU_BASE = process.env.PAYU_ENV === 'production' ? 'https://info.payu.in' : 'https://test.payu.in';

const generateTxnId = (orderNumber) => `${orderNumber}-${Date.now()}`;

const generatePayUHash = ({ txnid, amount, productinfo, firstname, email, udf1 = '' }) => {
  const str = [process.env.PAYU_MERCHANT_KEY, txnid, amount, productinfo, firstname, email, udf1, '', '', '', '', '', '', '', '', '', process.env.PAYU_SALT].join('|');
  return crypto.createHash('sha512').update(str).digest('hex');
};

const verifyPayUHash = ({ status, txnid, amount, productinfo, firstname, email, udf1 = '', hash }) => {
  const reverseStr = [process.env.PAYU_SALT, status, '', '', '', '', udf1, email, firstname, productinfo, amount, txnid, process.env.PAYU_MERCHANT_KEY].join('|');
  const expected = crypto.createHash('sha512').update(reverseStr).digest('hex');
  return expected === hash;
};

const createPaymentOrder = async (req, res, next) => {
  try {
    const { order_id, payment_method } = req.body;
    const orderResult = await query(
      `SELECT o.*, u.name, u.email, u.mobile FROM Orders o JOIN Users u ON o.user_id = u.id
       WHERE o.id = ? AND o.user_id = ? AND o.payment_status = 'pending'`,
      [order_id, req.user.id]
    );
    if (!orderResult.length) return notFound(res, 'Order not found or already paid');
    const order = orderResult[0];

    if (payment_method === 'cash_on_delivery') {
      await query(`INSERT INTO Payments (order_id, payment_method, amount, status) VALUES (?, 'cash_on_delivery', ?, 'pending')`, [order_id, order.total_amount]);
      await query(`UPDATE Orders SET status = 'confirmed', updated_at = NOW() WHERE id = ?`, [order_id]);
      await query(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?, 'confirmed', 'COD order confirmed', ?, 'system')`,
        [order_id, req.user.id]
      );
      return success(res, { payment_method: 'cash_on_delivery', order_id }, 'COD order confirmed');
    }

    const txnid = generateTxnId(order.order_number);
    const amount = order.total_amount.toFixed(2);
    const productinfo = `Pizza Order ${order.order_number}`;
    const firstname = (order.name || 'Customer').split(' ')[0];
    const email = order.email || `${order.mobile}@pizzahap.com`;
    const udf1 = order_id.toString();
    const hash = generatePayUHash({ txnid, amount, productinfo, firstname, email, udf1 });

    await query(
      `INSERT INTO Payments (order_id, gateway_order_id, payment_method, amount, status) VALUES (?, ?, ?, ?, 'pending')`,
      [order_id, txnid, payment_method, order.total_amount]
    );

    return created(res, {
      razorpay_order_id: txnid,
      amount: Math.round(parseFloat(amount) * 100),
      currency: 'INR',
      key_id: process.env.PAYU_MERCHANT_KEY,
      order_number: order.order_number,
      payu_params: {
        key: process.env.PAYU_MERCHANT_KEY, txnid, amount, productinfo, firstname, email,
        phone: order.mobile,
        surl: `${process.env.APP_URL}/api/payments/payu-webhook`,
        furl: `${process.env.APP_URL}/api/payments/payu-webhook`,
        hash, udf1, environment: process.env.PAYU_ENV === 'production' ? 0 : 1,
      },
    });
  } catch (err) { next(err); }
};

const verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_order_id: txnid, razorpay_payment_id: mihpayid, razorpay_signature: hash, order_id } = req.body;
    const paymentResult = await query(
      `SELECT p.*, o.order_number, o.total_amount, u.name, u.email, u.mobile
       FROM Payments p JOIN Orders o ON p.order_id = o.id JOIN Users u ON o.user_id = u.id
       WHERE p.gateway_order_id = ?`,
      [txnid]
    );
    if (!paymentResult.length) return notFound(res, 'Payment record not found');
    const payment = paymentResult[0];

    const isValid = verifyPayUHash({
      status: 'success', txnid, amount: payment.total_amount.toFixed(2),
      productinfo: `Pizza Order ${payment.order_number}`,
      firstname: (payment.name || 'Customer').split(' ')[0],
      email: payment.email || `${payment.mobile}@pizzahap.com`,
      udf1: order_id.toString(), hash,
    });

    if (!isValid) {
      await query(`UPDATE Payments SET status = 'failed', updated_at = NOW() WHERE gateway_order_id = ?`, [txnid]);
      return badRequest(res, 'Payment verification failed — hash mismatch');
    }

    await query(
      `UPDATE Payments SET gateway_payment_id = ?, gateway_signature = ?, status = 'captured', updated_at = NOW() WHERE gateway_order_id = ?`,
      [mihpayid, hash, txnid]
    );
    await query(`UPDATE Orders SET payment_status = 'paid', status = 'confirmed', updated_at = NOW() WHERE id = ?`, [order_id]);
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by_role) VALUES (?, 'confirmed', 'Payment successful via PayU', 'system')`,
      [order_id]
    );
    return success(res, { payment_id: mihpayid }, 'Payment successful');
  } catch (err) { next(err); }
};

const handleWebhook = async (req, res, next) => {
  try {
    const { status, txnid, amount, productinfo, firstname, email, udf1, mihpayid, hash } = req.body;
    logger.info(`PayU webhook: status=${status}, txnid=${txnid}`);

    const isValid = verifyPayUHash({ status, txnid, amount, productinfo, firstname, email, udf1, hash });
    if (!isValid) return res.status(400).send('Invalid hash');

    const orderId = parseInt(udf1);
    if (status === 'success') {
      await query(
        `UPDATE Payments SET gateway_payment_id = ?, gateway_signature = ?, status = 'captured', updated_at = NOW()
         WHERE gateway_order_id = ? AND status != 'captured'`,
        [mihpayid || '', hash, txnid]
      );
      await query(`UPDATE Orders SET payment_status = 'paid', status = 'confirmed' WHERE id = ? AND payment_status != 'paid'`, [orderId]);
    } else if (['failure', 'failed'].includes(status)) {
      await query(`UPDATE Payments SET status = 'failed', updated_at = NOW() WHERE gateway_order_id = ?`, [txnid]);
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error(`PayU webhook error: ${err.message}`);
    res.status(500).send('Webhook error');
  }
};

const initiatePayURefund = async ({ mihpayid, amount, refundId }) => {
  const tokenResp = await axios.post('https://accounts.payu.in/oauth/token', new URLSearchParams({
    client_id: process.env.PAYU_CLIENT_ID, client_secret: process.env.PAYU_CLIENT_SECRET,
    grant_type: 'client_credentials', scope: 'create_payment_links',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const accessToken = tokenResp.data.access_token;
  const refundResp = await axios.post(
    `${PAYU_BASE}/merchant/postservice?form=2`,
    new URLSearchParams({
      key: process.env.PAYU_MERCHANT_KEY, command: 'cancel_refund_transaction',
      var1: mihpayid, var2: refundId.toString(), var3: amount.toFixed(2),
      hash: crypto.createHash('sha512').update(`${process.env.PAYU_MERCHANT_KEY}|cancel_refund_transaction|${mihpayid}|${refundId}|${amount.toFixed(2)}|${process.env.PAYU_SALT}`).digest('hex'),
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${accessToken}` } }
  );
  return refundResp.data;
};

module.exports = { createPaymentOrder, verifyPayment, handleWebhook, initiatePayURefund };
