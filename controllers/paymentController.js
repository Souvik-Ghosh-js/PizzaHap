const crypto = require('crypto');
const axios = require('axios');
const { query, transaction } = require('../config/db');
const { success, created, badRequest, notFound } = require('../utils/response');
const { notifyUser, notifyAdmins } = require('../services/notificationService');
const logger = require('../utils/logger');

const PAYU_BASE = process.env.PAYU_ENV === 'production'
  ? 'https://info.payu.in'
  : 'https://test.payu.in';

const generateTxnId = () => `TXN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

// ── Calculate Order helper for initiation ──────────────────────────
const calculateOrderAmount = async (orderData, user) => {
  const { items, coupon_code, delivery_type = 'delivery', coins_to_redeem = 0 } = orderData;
  let subtotal = 0;
  const orderItems = [];

  for (const item of items) {
    const productResult = await query(
      `SELECT p.id, p.name, ps.price as size_price, ct.extra_price as crust_extra
       FROM Products p
       JOIN ProductSizes ps ON ps.id = ? AND ps.product_id = p.id
       LEFT JOIN CrustTypes ct ON ct.id = ?
       WHERE p.id = ? AND p.is_available = 1`,
      [item.size_id, item.crust_id || null, item.product_id]
    );
    if (!productResult.length) throw new Error(`Product not available`);
    const p = productResult[0];

    // Build subtotal
    let itemPrice = parseFloat(p.size_price) + parseFloat(p.crust_extra || 0);
    if (item.toppings?.length) {
      for (const tid of item.toppings) {
        const tr = await query(`SELECT price FROM Toppings WHERE id = ? AND is_available = 1`, [tid]);
        if (tr.length) itemPrice += parseFloat(tr[0].price);
      }
    }
    subtotal += itemPrice * (item.quantity || 1);
  }

  const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 40 : 0);
  let discount_amount = 0;
  if (coupon_code) {
    const cp = await query(`SELECT * FROM Coupons WHERE code = ? AND is_active = 1`, [coupon_code]);
    if (cp.length) {
      const coupon = cp[0];
      if (subtotal >= coupon.min_order_value) {
        if (coupon.discount_type === 'percentage') {
          discount_amount = Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount || Infinity);
        } else {
          discount_amount = parseFloat(coupon.discount_value);
        }
      }
    }
  }

  let coins_discount = 0;
  if (user && parseInt(coins_to_redeem) > 0) {
    const wallet = await query(`SELECT balance FROM UserCoins WHERE user_id = ?`, [user.id]);
    const balance = wallet.length ? wallet[0].balance : 0;
    coins_discount = Math.floor(Math.min(balance, coins_to_redeem, subtotal - discount_amount + delivery_fee));
  }

  const total = Math.max(0, subtotal - discount_amount - coins_discount + delivery_fee);
  return parseFloat(total.toFixed(2));
};

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

const verifyPayUHash = ({ status, txnid, amount, productinfo, firstname, email, udf1 = '', hash }) => {
  const reverseStr = [
    process.env.PAYU_SALT,
    status,
    '', '', '', '', '',
    '', '', '', '', udf1,
    email, firstname,
    productinfo, amount, txnid,
    process.env.PAYU_MERCHANT_KEY,
  ].join('|');
  const expected = crypto.createHash('sha512').update(reverseStr).digest('hex');
  return expected === hash;
};

// ── Initiate online payment WITHOUT creating order record ─────────
const initiateOnlinePayment = async (req, res, next) => {
  try {
    const orderData = req.body;
    const userId = req.user.id;
    const total_amount = await calculateOrderAmount(orderData, req.user);
    const txnid = generateTxnId();

    await query(
      `INSERT INTO PaymentInitiations (txnid, user_id, order_data, amount) VALUES (?, ?, ?, ?)`,
      [txnid, userId, JSON.stringify(orderData), total_amount]
    );

    const firstname = (req.user.name || 'Customer').split(' ')[0];
    const email = req.user.email || `${req.user.mobile}@pizzahap.com`;
    const phone = req.user.mobile || '9999999999';
    const productinfo = `Order from PizzaHap`;
    const hash = generatePayUHash({ txnid, amount: total_amount.toFixed(2), productinfo, firstname, email });

    return created(res, {
      txnid,
      amount: total_amount.toFixed(2),
      payu_params: {
        key: process.env.PAYU_MERCHANT_KEY,
        txnid,
        amount: total_amount.toFixed(2),
        productinfo,
        firstname,
        email,
        phone,
        surl: `${process.env.APP_URL}/api/payments/payu-webhook`,
        furl: `${process.env.APP_URL}/api/payments/payu-webhook`,
        hash,
        service_provider: 'payu_paisa',
      },
    });
  } catch (err) { next(err); }
};

// ── Internal helper to finalize order once payment is done ─────────
const finalizeOrderInternal = async (txnid) => {
  const initResult = await query(`SELECT * FROM PaymentInitiations WHERE txnid = ? AND status = 'pending'`, [txnid]);
  if (!initResult.length) return null;
  const init = initResult[0];

  const orderData = JSON.parse(init.order_data);
  const { placeOrderDirect } = require('./orderController'); // We'll add this internal method

  // Call the refactored placeOrder method that doesn't expect a Request object
  const orderId = await placeOrderDirect(init.user_id, orderData);
  
  if (orderId) {
    await query(`UPDATE PaymentInitiations SET status = 'completed' WHERE id = ?`, [init.id]);
    await query(`INSERT INTO Payments (order_id, gateway_order_id, payment_method, amount, status) VALUES (?, ?, 'online', ?, 'captured')`, [orderId, txnid, init.amount]);
    return orderId;
  }
  return null;
};

// ── Create payment order (legacy version, kept for compatibility if needed)
const createPaymentOrder = async (req, res, next) => {
  try {
    const { order_id, payment_method = 'upi' } = req.body;
    const orderResult = await query(`SELECT o.*, u.name, u.email, u.mobile FROM Orders o JOIN Users u ON o.user_id = u.id WHERE o.id = ? AND o.user_id = ? AND o.payment_status = 'pending'`, [order_id, req.user.id]);
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];
    const txnid = `TXN-OLD-${order.order_number}-${Date.now()}`;
    const amount = parseFloat(order.total_amount).toFixed(2);
    const productinfo = `Order ${order.order_number}`;
    const firstname = (order.name || 'Customer').split(' ')[0];
    const email = order.email || `${order.mobile}@pizzahap.com`;
    const hash = generatePayUHash({ txnid, amount, productinfo, firstname, email });
    await query(`INSERT INTO Payments (order_id, gateway_order_id, payment_method, amount, status) VALUES (?, ?, ?, ?, 'pending') ON DUPLICATE KEY UPDATE gateway_order_id = VALUES(gateway_order_id), updated_at = NOW()`, [order_id, txnid, payment_method, order.total_amount]);
    return created(res, { txnid, amount, payu_params: { key: process.env.PAYU_MERCHANT_KEY, txnid, amount, productinfo, firstname, email, phone: order.mobile, surl: `${process.env.APP_URL}/api/payments/payu-webhook`, furl: `${process.env.APP_URL}/api/payments/payu-webhook`, hash, service_provider: 'payu_paisa' }, order_id });
  } catch (err) { next(err); }
};

const verifyPayment = async (req, res, next) => {
  try {
    const txnid = req.body.txnid;
    const hash = req.body.hash;
    const status = req.body.status;
    if (!txnid || !status) return badRequest(res, 'Missing txnid or status');

    // First check if it's a new "Initiation" based order
    const initResult = await query(`SELECT user_id, amount, order_data FROM PaymentInitiations WHERE txnid = ?`, [txnid]);
    if (initResult.length) {
      if (status === 'success' || status === 'captured') {
        const orderId = await finalizeOrderInternal(txnid);
        if (orderId) return success(res, { order_id: orderId }, 'Payment successful and order placed');
      } else {
        await query(`UPDATE PaymentInitiations SET status = 'failed' WHERE txnid = ?`, [txnid]);
      }
    }

    // Fallback for legacy "order first" payments handled already
    return badRequest(res, 'Payment failed or record not found');
  } catch (err) { next(err); }
};

const handleWebhook = async (req, res, next) => {
  try {
    const { status, txnid, amount, hash, udf1 } = req.body;
    logger.info(`PayU Webhook txnid=${txnid} status=${status}`);
    
    if (status === 'success') {
      const orderId = await finalizeOrderInternal(txnid);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=success&order_id=${orderId || 0}`);
    } else {
      await query(`UPDATE PaymentInitiations SET status = 'failed' WHERE txnid = ? AND status = 'pending'`, [txnid]);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
    }
  } catch (err) {
    logger.error(`Webhook error: ${err.message}`);
    res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
  }
};

const initiatePayURefund = async ({ mihpayid, amount, refundId }) => {
  const tokenResp = await axios.post('https://accounts.payu.in/oauth/token', new URLSearchParams({ client_id: process.env.PAYU_CLIENT_ID, client_secret: process.env.PAYU_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'create_payment_links' }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const hash = crypto.createHash('sha512').update(`${process.env.PAYU_MERCHANT_KEY}|cancel_refund_transaction|${mihpayid}|${refundId}|${parseFloat(amount).toFixed(2)}|${process.env.PAYU_SALT}`).digest('hex');
  const resp = await axios.post(`${PAYU_BASE}/merchant/postservice?form=2`, new URLSearchParams({ key: process.env.PAYU_MERCHANT_KEY, command: 'cancel_refund_transaction', var1: mihpayid, var2: refundId.toString(), var3: parseFloat(amount).toFixed(2), hash }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${tokenResp.data.access_token}` } });
  return resp.data;
};

module.exports = { createPaymentOrder, verifyPayment, handleWebhook, initiatePayURefund, initiateOnlinePayment };
