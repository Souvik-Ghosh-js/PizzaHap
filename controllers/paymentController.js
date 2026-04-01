const crypto = require('crypto');
const axios  = require('axios');
const { query } = require('../config/db');
const { success, created, badRequest, notFound } = require('../utils/response');
const { notifyUser, notifyAdmins } = require('../services/notificationService');
const logger = require('../utils/logger');

const PAYU_BASE = process.env.PAYU_ENV === 'production'
  ? 'https://info.payu.in'
  : 'https://test.payu.in';

const generateTxnId = (orderNumber) => `${orderNumber}-${Date.now()}`;

// ── Hash helpers ──────────────────────────────────────────────────
/*  PayU forward hash: key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||salt  */
const generatePayUHash = ({ txnid, amount, productinfo, firstname, email, udf1 = '' }) => {
  const str = [
    process.env.PAYU_MERCHANT_KEY,
    txnid, amount, productinfo, firstname, email,
    udf1, '', '', '', '', '', '', '', '', '',
    process.env.PAYU_SALT,
  ].join('|');
  return crypto.createHash('sha512').update(str).digest('hex');
};

/*  PayU reverse hash (response verification):
    SHA512(salt|status|additional_charges|udf9|udf8|udf7|udf6|udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
    Fields 3-7 (additional_charges + udf9..udf6) are empty in standard integration.
    Fields 8-11 (udf5..udf2) are also empty since we only use udf1.  */
const verifyPayUHash = ({ status, txnid, amount, productinfo, firstname, email, udf1 = '', hash }) => {
  const reverseStr = [
    process.env.PAYU_SALT,
    status,
    '', '', '', '', '',        // additional_charges, udf9, udf8, udf7, udf6 (all empty)
    '',                        // udf5 (empty)
    '',                        // udf4 (empty)
    '',                        // udf3 (empty)
    '',                        // udf2 (empty)
    udf1,                      // udf1
    email, firstname,
    productinfo, amount, txnid,
    process.env.PAYU_MERCHANT_KEY,
  ].join('|');
  const expected = crypto.createHash('sha512').update(reverseStr).digest('hex');
  return expected === hash;
};

// ── Create payment order ──────────────────────────────────────────
const createPaymentOrder = async (req, res, next) => {
  try {
    const { order_id, payment_method = 'upi' } = req.body;
    const orderResult = await query(
      `SELECT o.*, u.name, u.email, u.mobile
       FROM Orders o JOIN Users u ON o.user_id = u.id
       WHERE o.id = ? AND o.user_id = ? AND o.payment_status = 'pending'`,
      [order_id, req.user.id]
    );
    if (!orderResult.length) return notFound(res, 'Order not found or already paid');
    const order = orderResult[0];

    // COD path
    if (payment_method === 'cash_on_delivery') {
      await query(
        `INSERT INTO Payments (order_id, payment_method, amount, status) VALUES (?, 'cash_on_delivery', ?, 'pending')`,
        [order_id, order.total_amount]
      );
      await query(`UPDATE Orders SET status = 'confirmed', payment_method = 'cash_on_delivery', updated_at = NOW() WHERE id = ?`, [order_id]);
      await query(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?, 'confirmed', 'COD order confirmed', ?, 'system')`,
        [order_id, req.user.id]
      );
      return success(res, { payment_method: 'cash_on_delivery', order_id }, 'COD order confirmed');
    }

    const txnid      = generateTxnId(order.order_number);
    const amount     = parseFloat(order.total_amount).toFixed(2);
    const productinfo = `Order ${order.order_number}`;
    const firstname  = (order.name || 'Customer').split(' ')[0];
    const email      = order.email || `${order.mobile}@pizzahap.com`;
    const phone      = order.mobile || '9999999999';
    const udf1       = order_id.toString();
    const hash       = generatePayUHash({ txnid, amount, productinfo, firstname, email, udf1 });

    // Upsert payment row (avoid duplicate if re-initiating)
    await query(
      `INSERT INTO Payments (order_id, gateway_order_id, payment_method, amount, status)
       VALUES (?, ?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE gateway_order_id = VALUES(gateway_order_id), updated_at = NOW()`,
      [order_id, txnid, payment_method, order.total_amount]
    );

    return created(res, {
      txnid,
      amount,
      currency: 'INR',
      order_id,
      order_number: order.order_number,
      payu_params: {
        key:         process.env.PAYU_MERCHANT_KEY,
        txnid,
        amount,
        productinfo,
        firstname,
        email,
        phone,
        surl:        `${process.env.APP_URL}/api/payments/payu-webhook`,
        furl:        `${process.env.APP_URL}/api/payments/payu-webhook`,
        hash,
        udf1,
        service_provider: 'payu_paisa',
      },
    });
  } catch (err) { next(err); }
};

// ── Verify payment (client-side callback) ────────────────────────
const verifyPayment = async (req, res, next) => {
  try {
    const txnid    = req.body.txnid    || req.body.razorpay_order_id;
    const mihpayid = req.body.mihpayid || req.body.razorpay_payment_id;
    const hash     = req.body.hash     || req.body.razorpay_signature;
    const status   = req.body.status;

    if (!txnid || !hash || !status) return badRequest(res, 'Missing required fields: txnid, hash, status');

    const paymentResult = await query(
      `SELECT p.*, o.order_number, o.total_amount, o.user_id, o.location_id, u.name, u.email, u.mobile
       FROM Payments p
       JOIN Orders o ON p.order_id = o.id
       JOIN Users u  ON o.user_id  = u.id
       WHERE p.gateway_order_id = ?`,
      [txnid]
    );
    if (!paymentResult.length) return notFound(res, 'Payment record not found');
    const payment = paymentResult[0];

    const isValid = verifyPayUHash({
      status,
      txnid,
      amount:      parseFloat(payment.total_amount).toFixed(2),
      productinfo: `Order ${payment.order_number}`,
      firstname:   (payment.name || 'Customer').split(' ')[0],
      email:       payment.email || `${payment.mobile}@pizzahap.com`,
      udf1:        payment.order_id.toString(),
      hash,
    });

    if (!isValid) {
      await query(`UPDATE Payments SET status = 'failed', updated_at = NOW() WHERE gateway_order_id = ?`, [txnid]);
      return badRequest(res, 'Payment verification failed — hash mismatch');
    }

    await query(
      `UPDATE Payments SET gateway_payment_id = ?, gateway_signature = ?, status = 'captured', updated_at = NOW()
       WHERE gateway_order_id = ? AND status != 'captured'`,
      [mihpayid, hash, txnid]
    );

    const updateRes = await query(
      `UPDATE Orders SET payment_status = 'paid', status = 'confirmed', updated_at = NOW()
       WHERE id = ? AND payment_status != 'paid'`,
      [payment.order_id]
    );

    if (updateRes.affectedRows > 0) {
      await query(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by_role) VALUES (?, 'confirmed', 'Payment verified via PayU', 'system')`,
        [payment.order_id]
      );
      // Trigger notifications for online payment now that it is confirmed
      await notifyUser(payment.user_id, 'Order Placed!', `Your order ${payment.order_number} confirmed. Total: Rs.${payment.total_amount}`, 'order', { order_id: payment.order_id, order_number: payment.order_number });
      await notifyAdmins(payment.location_id, 'New Order Received', `Order ${payment.order_number} (Rs.${payment.total_amount}) - Paid Online`, 'order', { order_id: payment.order_id, order_number: payment.order_number, payment_method: 'online' });
    }
    return success(res, { payment_id: mihpayid, order_id: payment.order_id }, 'Payment successful');
  } catch (err) { next(err); }
};

// ── PayU webhook / surl+furl redirect ────────────────────────────
const handleWebhook = async (req, res, next) => {
  try {
    const { status, txnid, amount, productinfo, firstname, email, udf1, mihpayid, hash } = req.body;
    logger.info(`PayU webhook: status=${status}, txnid=${txnid}`);

    if (!txnid || !hash || !status) {
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
    }

    const isValid = verifyPayUHash({ status, txnid, amount: amount || '', productinfo: productinfo || '', firstname: firstname || '', email: email || '', udf1: udf1 || '', hash });
    if (!isValid) {
      logger.warn(`PayU webhook invalid hash for txnid=${txnid}`);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=${parseInt(udf1) || 0}`);
    }

    const orderId = parseInt(udf1);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      logger.warn(`PayU webhook invalid order_id in udf1=${udf1}`);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
    }

    if (status === 'success') {
      await query(
        `UPDATE Payments SET gateway_payment_id = ?, gateway_signature = ?, status = 'captured', updated_at = NOW()
         WHERE gateway_order_id = ? AND status != 'captured'`,
        [mihpayid || '', hash, txnid]
      );
      const updateRes = await query(
        `UPDATE Orders SET payment_status = 'paid', status = 'confirmed', updated_at = NOW()
         WHERE id = ? AND payment_status != 'paid'`,
        [orderId]
      );
      if (updateRes.affectedRows > 0) {
        await query(
          `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by_role) VALUES (?, 'confirmed', 'Payment confirmed via PayU', 'system')`,
          [orderId]
        );
        // Fetch order details for notification
        const orderRes = await query(`SELECT order_number, total_amount, user_id, location_id FROM Orders WHERE id = ?`, [orderId]);
        if (orderRes.length) {
          const o = orderRes[0];
          await notifyUser(o.user_id, 'Order Placed!', `Your order ${o.order_number} confirmed. Total: Rs.${o.total_amount}`, 'order', { order_id: orderId, order_number: o.order_number });
          await notifyAdmins(o.location_id, 'New Order Received', `Order ${o.order_number} (Rs.${o.total_amount}) - Paid Online`, 'order', { order_id: orderId, order_number: o.order_number, payment_method: 'online' });
        }
      }
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=success&order_id=${orderId}`);
    } else {
      await query(`UPDATE Payments SET status = 'failed', updated_at = NOW() WHERE gateway_order_id = ?`, [txnid]);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=${orderId}`);
    }
  } catch (err) {
    logger.error(`PayU webhook error: ${err.message}`);
    res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
  }
};

// ── Initiate PayU refund (called from refundController) ──────────
const initiatePayURefund = async ({ mihpayid, amount, refundId }) => {
  // Obtain OAuth token
  const tokenResp = await axios.post(
    'https://accounts.payu.in/oauth/token',
    new URLSearchParams({
      client_id:     process.env.PAYU_CLIENT_ID,
      client_secret: process.env.PAYU_CLIENT_SECRET,
      grant_type:    'client_credentials',
      scope:         'create_payment_links',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const accessToken = tokenResp.data.access_token;

  // Build refund hash: key|cancel_refund_transaction|var1|var2|var3|salt
  const refundHash = crypto
    .createHash('sha512')
    .update(`${process.env.PAYU_MERCHANT_KEY}|cancel_refund_transaction|${mihpayid}|${refundId}|${parseFloat(amount).toFixed(2)}|${process.env.PAYU_SALT}`)
    .digest('hex');

  const refundResp = await axios.post(
    `${PAYU_BASE}/merchant/postservice?form=2`,
    new URLSearchParams({
      key:     process.env.PAYU_MERCHANT_KEY,
      command: 'cancel_refund_transaction',
      var1:    mihpayid,
      var2:    refundId.toString(),
      var3:    parseFloat(amount).toFixed(2),
      hash:    refundHash,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );
  return refundResp.data;
};

module.exports = { createPaymentOrder, verifyPayment, handleWebhook, initiatePayURefund };
