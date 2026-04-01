const crypto = require('crypto');
const axios = require('axios');
const { query, transaction } = require('../config/db');
const { success, created, badRequest, notFound } = require('../utils/response');
const { notifyUser, notifyAdmins } = require('../services/notificationService');
const logger = require('../utils/logger');

const PAYU_BASE = process.env.PAYU_ENV === 'production'
  ? 'https://info.payu.in'
  : 'https://test.payu.in';

const generateTxnId = () => `TXN-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

const generateOrderNumber = () => {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PIZZAHAP-${ts}${rand}`;
};

// ── Hash helpers ──────────────────────────────────────────────────
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
    '', '', '', '',
    udf1,
    email, firstname,
    productinfo, amount, txnid,
    process.env.PAYU_MERCHANT_KEY,
  ].join('|');
  const expected = crypto.createHash('sha512').update(reverseStr).digest('hex');
  return expected === hash;
};

// ── Helper: validate items & compute totals (shared by placeOrder & initiate) ──
const validateAndComputeOrder = async (body, userId) => {
  const {
    items, location_id, delivery_type = 'delivery',
    delivery_address, delivery_latitude, delivery_longitude,
    coupon_code, special_instructions,
    payment_method = 'online',
    coins_to_redeem = 0,
  } = body;

  let subtotal = 0;
  const orderItems = [];

  for (const item of items) {
    const productResult = await query(
      `SELECT p.*, ps.price as size_price, ps.size_name,
              ct.extra_price as crust_extra, ct.name as crust_name
       FROM Products p
       JOIN ProductSizes ps ON ps.id = ? AND ps.product_id = p.id
       LEFT JOIN CrustTypes ct ON ct.id = ?
       WHERE p.id = ? AND p.is_available = 1`,
      [item.size_id, item.crust_id || null, item.product_id]
    );
    if (!productResult.length) throw { status: 400, message: 'Product not available' };
    const product = productResult[0];

    if (product.stock_quantity < (item.quantity || 1)) {
      throw { status: 400, message: `Insufficient stock for ${product.name}. Available: ${product.stock_quantity}` };
    }

    let itemPrice = parseFloat(product.size_price) + parseFloat(product.crust_extra || 0);
    const itemToppings = [];
    if (item.toppings?.length) {
      for (const tid of item.toppings) {
        const tr = await query(`SELECT * FROM Toppings WHERE id = ? AND is_available = 1`, [tid]);
        if (tr.length) { itemPrice += parseFloat(tr[0].price); itemToppings.push(tr[0]); }
      }
    }
    const total_price = parseFloat((itemPrice * (item.quantity || 1)).toFixed(2));
    subtotal += total_price;
    orderItems.push({ ...item, product, unit_price: itemPrice, total_price, toppings: itemToppings });
  }

  subtotal = parseFloat(subtotal.toFixed(2));
  const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 0 : 0);
  let discount_amount = 0, couponId = null;

  if (coupon_code) {
    const couponResult = await query(
      `SELECT * FROM Coupons WHERE code = ? AND is_active = 1 AND valid_from <= NOW() AND valid_until >= NOW() AND (usage_limit IS NULL OR used_count < usage_limit)`,
      [coupon_code]
    );
    if (!couponResult.length) throw { status: 400, message: 'Invalid coupon' };
    const coupon = couponResult[0];
    if (subtotal < coupon.min_order_value) throw { status: 400, message: `Min order Rs.${coupon.min_order_value} required` };
    if (coupon.discount_type === 'buy_1_get_1') {
      const applicableIds = coupon.applicable_product_ids
        ? (typeof coupon.applicable_product_ids === 'string' ? JSON.parse(coupon.applicable_product_ids) : coupon.applicable_product_ids)
        : [];
      const eligible = applicableIds.length > 0
        ? orderItems.filter(i => applicableIds.includes(i.product_id))
        : orderItems;
      if (!eligible.length) throw { status: 400, message: 'No eligible items in cart for this BOGO coupon' };
      discount_amount = parseFloat(Math.min(...eligible.map(i => i.unit_price)).toFixed(2));
    } else if (coupon.discount_type === 'percentage') {
      discount_amount = Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount || Infinity);
      discount_amount = parseFloat(discount_amount.toFixed(2));
    } else {
      discount_amount = parseFloat(parseFloat(coupon.discount_value).toFixed(2));
    }
    couponId = coupon.id;
  }

  let coins_discount = 0, coinsToRedeem = parseInt(coins_to_redeem) || 0;
  if (coinsToRedeem > 0) {
    const walletRow = await query(`SELECT balance FROM UserCoins WHERE user_id = ?`, [userId]);
    const available = walletRow.length ? walletRow[0].balance : 0;
    coinsToRedeem = Math.min(coinsToRedeem, available);
    coins_discount = Math.floor(Math.max(0, Math.min(coinsToRedeem, subtotal - discount_amount + delivery_fee)));
    coinsToRedeem = coins_discount;
  }

  const total_amount = parseFloat((subtotal - discount_amount - coins_discount + delivery_fee).toFixed(2));

  return {
    orderItems, subtotal, delivery_fee, discount_amount, couponId, coinsToRedeem, coins_discount, total_amount,
    location_id, delivery_type, delivery_address, delivery_latitude, delivery_longitude,
    coupon_code, special_instructions, payment_method,
  };
};

// ── Helper: insert order into DB (used by placeOrder for COD & webhook for online) ──
const insertOrder = async (computed, userId) => {
  const {
    orderItems, subtotal, delivery_fee, discount_amount, couponId,
    coinsToRedeem, total_amount, location_id, delivery_type,
    delivery_address, delivery_latitude, delivery_longitude,
    special_instructions, payment_method,
  } = computed;

  const order_number = generateOrderNumber();

  const orderId = await transaction(async (conn) => {
    const [orderResult] = await conn.execute(
      `INSERT INTO Orders
        (order_number, user_id, location_id, delivery_type,
         delivery_address, delivery_latitude, delivery_longitude,
         subtotal, discount_amount, delivery_fee, tax_amount, total_amount,
         coupon_id, special_instructions, payment_status, payment_method, coins_redeemed, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?, ?)`,
      [
        order_number, userId, location_id, delivery_type,
        delivery_address || null, delivery_latitude || null, delivery_longitude || null,
        subtotal, discount_amount, delivery_fee, total_amount,
        couponId, special_instructions || null,
        payment_method === 'cash_on_delivery' ? 'pending' : 'paid',
        payment_method,
        coinsToRedeem,
        'confirmed',
      ]
    );
    const newOrderId = orderResult.insertId;

    for (const item of orderItems) {
      const [itemResult] = await conn.execute(
        `INSERT INTO OrderItems
          (order_id, product_id, product_name, size_id, size_name,
           crust_id, crust_name, quantity, unit_price, total_price, special_instructions)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [newOrderId, item.product_id, item.product.name, item.size_id,
          item.product.size_name, item.crust_id || null, item.product.crust_name || null,
          item.quantity || 1,
          parseFloat(item.unit_price).toFixed(2), item.total_price,
          item.special_instructions || null]
      );
      for (const topping of item.toppings) {
        await conn.execute(
          `INSERT INTO OrderItemToppings (order_item_id, topping_id, topping_name, price) VALUES (?,?,?,?)`,
          [itemResult.insertId, topping.id, topping.name, topping.price]
        );
      }
      // Deduct stock
      await conn.execute(
        `UPDATE Products SET stock_quantity = stock_quantity - ? WHERE id = ?`,
        [item.quantity || 1, item.product_id]
      );
    }

    await conn.execute(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,'confirmed','Order placed & confirmed',?,'system')`,
      [newOrderId, userId]
    );

    if (couponId) {
      await conn.execute(`UPDATE Coupons SET used_count = used_count + 1 WHERE id = ?`, [couponId]);
      await conn.execute(`INSERT INTO UserCouponUsage (user_id, coupon_id, order_id) VALUES (?,?,?)`, [userId, couponId, newOrderId]);
    }

    if (coinsToRedeem > 0) {
      await conn.execute(
        `UPDATE UserCoins SET balance = GREATEST(0, balance - ?), updated_at = NOW() WHERE user_id = ?`,
        [coinsToRedeem, userId]
      );
      await conn.execute(
        `INSERT INTO CoinTransactions (user_id, order_id, type, coins, description) VALUES (?,?,'redeemed',?,?)`,
        [userId, newOrderId, coinsToRedeem, `Redeemed for order #${order_number}`]
      );
    }
    return newOrderId;
  });

  return { orderId, order_number, total_amount, coinsToRedeem };
};

// ── Initiate online payment (NO order created yet) ───────────────
const initiateOnlinePayment = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const computed = await validateAndComputeOrder(req.body, userId);

    const userResult = await query(`SELECT name, email, mobile FROM Users WHERE id = ?`, [userId]);
    if (!userResult.length) return notFound(res, 'User not found');
    const user = userResult[0];

    const txnid = generateTxnId();
    const amount = computed.total_amount.toFixed(2);
    const productinfo = `PizzaHap Order`;
    const firstname = (user.name || 'Customer').split(' ')[0];
    const email = user.email || `${user.mobile}@pizzahap.com`;
    const phone = user.mobile || '9999999999';
    const udf1 = txnid; // self-reference — we look up PaymentInitiations by txnid
    const hash = generatePayUHash({ txnid, amount, productinfo, firstname, email, udf1 });

    // Store order data in PaymentInitiations — order is NOT created yet
    await query(
      `INSERT INTO PaymentInitiations (txnid, user_id, order_data, amount, status) VALUES (?, ?, ?, ?, 'pending')`,
      [txnid, userId, JSON.stringify(req.body), computed.total_amount]
    );

    return created(res, {
      txnid,
      amount,
      total_amount: computed.total_amount,
      coins_discount: computed.coins_discount,
      payu_params: {
        key: process.env.PAYU_MERCHANT_KEY,
        txnid,
        amount,
        productinfo,
        firstname,
        email,
        phone,
        surl: `${process.env.APP_URL}/api/payments/payu-webhook`,
        furl: `${process.env.APP_URL}/api/payments/payu-webhook`,
        hash,
        udf1,
        service_provider: 'payu_paisa',
      },
    });
  } catch (err) {
    if (err.status === 400) return badRequest(res, err.message);
    next(err);
  }
};

// ── Create payment order (legacy — kept for COD path) ────────────
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

    return badRequest(res, 'Use /payments/initiate for online payments');
  } catch (err) { next(err); }
};

// ── Verify payment (client-side callback) ────────────────────────
const verifyPayment = async (req, res, next) => {
  try {
    const txnid = req.body.txnid || req.body.razorpay_order_id;
    const mihpayid = req.body.mihpayid || req.body.razorpay_payment_id;
    const hash = req.body.hash || req.body.razorpay_signature;
    const status = req.body.status;

    if (!txnid || !hash || !status) return badRequest(res, 'Missing required fields: txnid, hash, status');

    const piResult = await query(`SELECT * FROM PaymentInitiations WHERE txnid = ?`, [txnid]);
    if (!piResult.length) return notFound(res, 'Payment initiation not found');
    const pi = piResult[0];

    const userResult = await query(`SELECT name, email, mobile FROM Users WHERE id = ?`, [pi.user_id]);
    const user = userResult[0] || {};

    const isValid = verifyPayUHash({
      status, txnid,
      amount: parseFloat(pi.amount).toFixed(2),
      productinfo: 'PizzaHap Order',
      firstname: (user.name || 'Customer').split(' ')[0],
      email: user.email || `${user.mobile}@pizzahap.com`,
      udf1: txnid,
      hash,
    });

    if (!isValid) return badRequest(res, 'Payment verification failed — hash mismatch');
    return success(res, { payment_id: mihpayid, txnid }, 'Payment verified');
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
      await query(`UPDATE PaymentInitiations SET status = 'failed', updated_at = NOW() WHERE txnid = ?`, [txnid]);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
    }

    // Look up the pending payment initiation
    const piResult = await query(`SELECT * FROM PaymentInitiations WHERE txnid = ? AND status = 'pending'`, [txnid]);
    if (!piResult.length) {
      logger.warn(`PayU webhook: no pending initiation for txnid=${txnid}`);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
    }
    const pi = piResult[0];

    if (status === 'success') {
      // NOW create the actual order
      try {
        const orderData = JSON.parse(pi.order_data);
        const computed = await validateAndComputeOrder(orderData, pi.user_id);
        const { orderId, order_number, total_amount, coinsToRedeem } = await insertOrder(computed, pi.user_id);

        // Record payment
        await query(
          `INSERT INTO Payments (order_id, gateway_order_id, gateway_payment_id, gateway_signature, payment_method, amount, status)
           VALUES (?, ?, ?, ?, 'online', ?, 'captured')`,
          [orderId, txnid, mihpayid || '', hash, total_amount]
        );

        // Mark initiation as completed
        await query(`UPDATE PaymentInitiations SET status = 'completed', updated_at = NOW() WHERE txnid = ?`, [txnid]);

        // Notifications
        await notifyUser(pi.user_id, 'Order Placed!', `Your order ${order_number} confirmed. Total: Rs.${total_amount}`, 'order', { order_id: orderId, order_number });
        await notifyAdmins(computed.location_id, 'New Order Received', `Order ${order_number} (Rs.${total_amount}) - Paid Online`, 'order', { order_id: orderId, order_number, payment_method: 'online' });

        return res.redirect(`${process.env.APP_URL}/api/payments/result?status=success&order_id=${orderId}&order_number=${order_number}&total=${total_amount}&coins_redeemed=${coinsToRedeem}`);
      } catch (orderErr) {
        logger.error(`PayU webhook order creation failed: ${orderErr.message}`);
        await query(`UPDATE PaymentInitiations SET status = 'failed', updated_at = NOW() WHERE txnid = ?`, [txnid]);
        return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
      }
    } else {
      // Payment failed — just mark initiation as failed, no order was created
      await query(`UPDATE PaymentInitiations SET status = 'failed', updated_at = NOW() WHERE txnid = ?`, [txnid]);
      return res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
    }
  } catch (err) {
    logger.error(`PayU webhook error: ${err.message}`);
    res.redirect(`${process.env.APP_URL}/api/payments/result?status=failed&order_id=0`);
  }
};

// ── Initiate PayU refund (called from refundController) ──────────
const initiatePayURefund = async ({ mihpayid, amount, refundId }) => {
  const tokenResp = await axios.post(
    'https://accounts.payu.in/oauth/token',
    new URLSearchParams({
      client_id: process.env.PAYU_CLIENT_ID,
      client_secret: process.env.PAYU_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'create_payment_links',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const accessToken = tokenResp.data.access_token;

  const refundHash = crypto
    .createHash('sha512')
    .update(`${process.env.PAYU_MERCHANT_KEY}|cancel_refund_transaction|${mihpayid}|${refundId}|${parseFloat(amount).toFixed(2)}|${process.env.PAYU_SALT}`)
    .digest('hex');

  const refundResp = await axios.post(
    `${PAYU_BASE}/merchant/postservice?form=2`,
    new URLSearchParams({
      key: process.env.PAYU_MERCHANT_KEY,
      command: 'cancel_refund_transaction',
      var1: mihpayid,
      var2: refundId.toString(),
      var3: parseFloat(amount).toFixed(2),
      hash: refundHash,
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

module.exports = { initiateOnlinePayment, createPaymentOrder, verifyPayment, handleWebhook, initiatePayURefund };
