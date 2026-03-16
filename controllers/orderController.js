const { query, transaction } = require('../config/db');
const { success, created, badRequest, notFound, paginated } = require('../utils/response');
const { notifyUser, notifyAdmins, creditCoins } = require('../services/notificationService');

const generateOrderNumber = () => {
  const ts   = Date.now().toString().slice(-6);
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `GOBT-${ts}${rand}`;
};

// ── Helper: build price for a single item ─────────────────────────
const buildItemPrice = async (item) => {
  const sizeResult = await query(
    `SELECT price FROM ProductSizes WHERE id = ? AND is_available = 1`, [item.size_id]
  );
  if (!sizeResult.length) throw new Error(`Invalid or unavailable size`);
  let itemPrice = parseFloat(sizeResult[0].price);

  if (item.crust_id) {
    const cr = await query(`SELECT extra_price FROM CrustTypes WHERE id = ? AND is_available = 1`, [item.crust_id]);
    if (cr.length) itemPrice += parseFloat(cr[0].extra_price);
  }
  if (item.toppings?.length) {
    for (const tid of item.toppings) {
      const tr = await query(`SELECT price FROM Toppings WHERE id = ? AND is_available = 1`, [tid]);
      if (tr.length) itemPrice += parseFloat(tr[0].price);
    }
  }
  return itemPrice;
};

// ── Calculate order totals (preview) ─────────────────────────────
const calculateOrder = async (req, res, next) => {
  try {
    const { items, coupon_code, delivery_type = 'delivery', coins_to_redeem = 0 } = req.body;
    let subtotal = 0;

    for (const item of items) {
      const price = await buildItemPrice(item);
      subtotal += price * (item.quantity || 1);
    }
    subtotal = parseFloat(subtotal.toFixed(2));

    const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 40 : 0);
    let discount_amount = 0, coupon = null;

    if (coupon_code) {
      const couponResult = await query(
        `SELECT * FROM Coupons WHERE code = ? AND is_active = 1 AND valid_from <= NOW() AND valid_until >= NOW() AND (usage_limit IS NULL OR used_count < usage_limit)`,
        [coupon_code]
      );
      if (!couponResult.length) return badRequest(res, 'Invalid or expired coupon');
      coupon = couponResult[0];
      if (subtotal < coupon.min_order_value) return badRequest(res, `Min order Rs.${coupon.min_order_value} required`);
      discount_amount = coupon.discount_type === 'percentage'
        ? Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount || Infinity)
        : coupon.discount_value;
      discount_amount = parseFloat(discount_amount.toFixed(2));
    }

    let coins_discount = 0, available_coins = 0;
    if (req.user && parseInt(coins_to_redeem) > 0) {
      const walletRow = await query(`SELECT balance FROM UserCoins WHERE user_id = ?`, [req.user.id]);
      available_coins = walletRow.length ? walletRow[0].balance : 0;
      const redeemable = Math.min(parseInt(coins_to_redeem) || 0, available_coins);
      coins_discount = Math.floor(Math.max(0, Math.min(redeemable, subtotal - discount_amount + delivery_fee)));
    }

    // NO TAX
    const total_amount = parseFloat((subtotal - discount_amount - coins_discount + delivery_fee).toFixed(2));

    return success(res, {
      subtotal,
      discount_amount,
      delivery_fee,
      coins_discount,
      tax_amount: 0,
      total_amount,
      available_coins,
      coupon,
    });
  } catch (err) { next(err); }
};

// ── Place order ───────────────────────────────────────────────────
const placeOrder = async (req, res, next) => {
  try {
    const {
      items, location_id, delivery_type = 'delivery',
      delivery_address, delivery_latitude, delivery_longitude,
      coupon_code, special_instructions,
      payment_method = 'online',
      coins_to_redeem = 0,
    } = req.body;
    const userId = req.user.id;

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
      if (!productResult.length) return badRequest(res, `Product not available`);
      const product = productResult[0];

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
    const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 40 : 0);
    let discount_amount = 0, couponId = null;

    if (coupon_code) {
      const couponResult = await query(
        `SELECT * FROM Coupons WHERE code = ? AND is_active = 1 AND valid_from <= NOW() AND valid_until >= NOW() AND (usage_limit IS NULL OR used_count < usage_limit)`,
        [coupon_code]
      );
      if (!couponResult.length) return badRequest(res, 'Invalid coupon');
      const coupon = couponResult[0];
      if (subtotal < coupon.min_order_value) return badRequest(res, `Min order Rs.${coupon.min_order_value} required`);
      discount_amount = coupon.discount_type === 'percentage'
        ? Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount || Infinity)
        : coupon.discount_value;
      discount_amount = parseFloat(discount_amount.toFixed(2));
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

    // NO TAX — total = subtotal - discount - coins_discount + delivery
    const total_amount = parseFloat((subtotal - discount_amount - coins_discount + delivery_fee).toFixed(2));
    const order_number = generateOrderNumber();

    const orderId = await transaction(async (conn) => {
      const [orderResult] = await conn.execute(
        `INSERT INTO Orders
          (order_number, user_id, location_id, delivery_type,
           delivery_address, delivery_latitude, delivery_longitude,
           subtotal, discount_amount, delivery_fee, tax_amount, total_amount,
           coupon_id, special_instructions, payment_status, payment_method, coins_redeemed)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,'pending',?,?)`,
        [
          order_number, userId, location_id, delivery_type,
          delivery_address || null, delivery_latitude || null, delivery_longitude || null,
          subtotal, discount_amount, delivery_fee, total_amount,
          couponId, special_instructions || null, payment_method, coinsToRedeem,
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
      }

      await conn.execute(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,'pending','Order placed',?,'user')`,
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

    await notifyUser(userId, 'Order Placed!', `Your order ${order_number} placed. Total: Rs.${total_amount}`, 'order', { order_id: orderId, order_number });
    await notifyAdmins(location_id, 'New Order Received', `Order ${order_number} (Rs.${total_amount}) - ${payment_method === 'cash_on_delivery' ? 'Cash on Delivery' : 'Online Payment'}`, 'order', { order_id: orderId, order_number, payment_method });

    return created(res, { order_id: orderId, order_number, total_amount, coins_redeemed: coinsToRedeem, coins_discount }, 'Order placed successfully');
  } catch (err) { next(err); }
};

const getMyOrders = async (req, res, next) => {
  try {
    const { status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;
    let where = `WHERE o.user_id = ?`;
    const params = [req.user.id];
    if (status) { where += ` AND o.status = ?`; params.push(status); }
    const countRes = await query(`SELECT COUNT(*) as total FROM Orders o ${where}`, params);
    const result  = await query(
      `SELECT o.*, l.name as location_name FROM Orders o LEFT JOIN Locations l ON o.location_id = l.id ${where} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const getOrderById = async (req, res, next) => {
  try {
    const orderResult = await query(
      `SELECT o.*, l.name as location_name, l.address as location_address
       FROM Orders o LEFT JOIN Locations l ON o.location_id = l.id
       WHERE o.id = ? AND o.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];
    const [items, history, payment, feedback] = await Promise.all([
      query(`SELECT oi.*, p.image_url FROM OrderItems oi LEFT JOIN Products p ON oi.product_id = p.id WHERE oi.order_id = ?`, [order.id]),
      query(`SELECT * FROM OrderStatusHistory WHERE order_id = ? ORDER BY created_at ASC`, [order.id]),
      query(`SELECT payment_method, status, amount FROM Payments WHERE order_id = ?`, [order.id]),
      query(`SELECT * FROM OrderFeedback WHERE order_id = ?`, [order.id]),
    ]);
    for (const item of items) {
      item.toppings = await query(`SELECT * FROM OrderItemToppings WHERE order_item_id = ?`, [item.id]);
    }
    return success(res, { ...order, items, status_history: history, payment: payment[0] || null, feedback: feedback[0] || null });
  } catch (err) { next(err); }
};

const cancelOrder = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const orderResult = await query(`SELECT * FROM Orders WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];
    if (!['pending', 'confirmed'].includes(order.status)) return badRequest(res, 'Order cannot be cancelled at this stage');

    await transaction(async (conn) => {
      await conn.execute(
        `UPDATE Orders SET status = 'cancelled', cancellation_reason = ?, cancellation_time = NOW(), cancelled_by = 'user', updated_at = NOW() WHERE id = ?`,
        [reason || 'Cancelled by user', order.id]
      );
      await conn.execute(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,'cancelled',?,?,'user')`,
        [order.id, reason || 'Cancelled by user', req.user.id]
      );
      if (order.coins_redeemed > 0) {
        await conn.execute(
          `INSERT INTO UserCoins (user_id, balance) VALUES (?,?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), updated_at = NOW()`,
          [req.user.id, order.coins_redeemed]
        );
        await conn.execute(
          `INSERT INTO CoinTransactions (user_id, order_id, type, coins, description) VALUES (?,?,'reverted',?,'Order cancelled - coins restored')`,
          [req.user.id, order.id, order.coins_redeemed]
        );
      }
    });

    await notifyUser(req.user.id, 'Order Cancelled', `Your order ${order.order_number} has been cancelled.`, 'order', { order_id: order.id });
    return success(res, {}, 'Order cancelled successfully');
  } catch (err) { next(err); }
};

const reorder = async (req, res, next) => {
  try {
    const orderResult = await query(
      `SELECT oi.product_id, oi.size_id, oi.crust_id, oi.quantity, oi.special_instructions,
              GROUP_CONCAT(CAST(oit.topping_id AS CHAR)) as topping_ids
       FROM OrderItems oi
       LEFT JOIN OrderItemToppings oit ON oit.order_item_id = oi.id
       WHERE oi.order_id = ? GROUP BY oi.id`,
      [req.params.id]
    );
    if (!orderResult.length) return notFound(res, 'Order not found');
    const cartItems = orderResult.map(item => ({
      product_id: item.product_id, size_id: item.size_id, crust_id: item.crust_id,
      quantity: item.quantity, special_instructions: item.special_instructions,
      toppings: item.topping_ids ? item.topping_ids.split(',').map(Number) : [],
    }));
    return success(res, { items: cartItems }, 'Items ready to reorder');
  } catch (err) { next(err); }
};

const submitOrderFeedback = async (req, res, next) => {
  try {
    const { food_rating, delivery_rating, overall_rating, comment } = req.body;
    const orderId = req.params.id;
    const orderCheck = await query(
      `SELECT id FROM Orders WHERE id = ? AND user_id = ? AND status = 'delivered'`, [orderId, req.user.id]
    );
    if (!orderCheck.length) return badRequest(res, 'Can only give feedback on delivered orders');
    const existing = await query(`SELECT id FROM OrderFeedback WHERE order_id = ?`, [orderId]);
    if (existing.length) return badRequest(res, 'Feedback already submitted for this order');
    await query(
      `INSERT INTO OrderFeedback (order_id, user_id, food_rating, delivery_rating, overall_rating, comment) VALUES (?,?,?,?,?,?)`,
      [orderId, req.user.id, food_rating, delivery_rating || null, overall_rating, comment || null]
    );
    return created(res, {}, 'Thank you for your feedback!');
  } catch (err) { next(err); }
};

const getMyCoinBalance = async (req, res, next) => {
  try {
    const wallet = await query(`SELECT balance FROM UserCoins WHERE user_id = ?`, [req.user.id]);
    const transactions = await query(
      `SELECT ct.*, o.order_number FROM CoinTransactions ct
       LEFT JOIN Orders o ON ct.order_id = o.id
       WHERE ct.user_id = ? ORDER BY ct.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    return success(res, { balance: wallet.length ? wallet[0].balance : 0, transactions });
  } catch (err) { next(err); }
};

module.exports = {
  calculateOrder, placeOrder, getMyOrders, getOrderById,
  cancelOrder, reorder, submitOrderFeedback, getMyCoinBalance,
};
