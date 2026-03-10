const { query, transaction } = require('../config/db');
const { success, created, badRequest, notFound, paginated } = require('../utils/response');

const generateOrderNumber = () => {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `GOBT-${ts}${rand}`;
};

const calculateOrder = async (req, res, next) => {
  try {
    const { items, coupon_code, delivery_type = 'delivery' } = req.body;
    let subtotal = 0;

    for (const item of items) {
      const sizeResult = await query(`SELECT price FROM ProductSizes WHERE id = ? AND is_available = 1`, [item.size_id]);
      if (!sizeResult.length) return badRequest(res, `Invalid size for item`);
      let itemPrice = sizeResult[0].price;

      if (item.crust_id) {
        const crustResult = await query(`SELECT extra_price FROM CrustTypes WHERE id = ?`, [item.crust_id]);
        if (crustResult.length) itemPrice += crustResult[0].extra_price;
      }

      if (item.toppings && item.toppings.length) {
        for (const toppingId of item.toppings) {
          const tr = await query(`SELECT price FROM Toppings WHERE id = ? AND is_available = 1`, [toppingId]);
          if (tr.length) itemPrice += tr[0].price;
        }
      }
      subtotal += itemPrice * (item.quantity || 1);
    }

    const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 40 : 0);
    const tax_rate = 0.05;
    let discount_amount = 0;
    let coupon = null;

    if (coupon_code) {
      const couponResult = await query(
        `SELECT * FROM Coupons WHERE code = ? AND is_active = 1
         AND valid_from <= NOW() AND valid_until >= NOW()
         AND (usage_limit IS NULL OR used_count < usage_limit)`,
        [coupon_code]
      );
      if (couponResult.length) {
        coupon = couponResult[0];
        if (subtotal >= coupon.min_order_value) {
          discount_amount = coupon.discount_type === 'percentage'
            ? Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount || Infinity)
            : coupon.discount_value;
        } else {
          return badRequest(res, `Min order ₹${coupon.min_order_value} required for this coupon`);
        }
      } else {
        return badRequest(res, 'Invalid or expired coupon');
      }
    }

    const taxable = subtotal - discount_amount + delivery_fee;
    const tax_amount = parseFloat((taxable * tax_rate).toFixed(2));
    const total_amount = parseFloat((taxable + tax_amount).toFixed(2));
    return success(res, { subtotal, discount_amount, delivery_fee, tax_amount, total_amount, coupon });
  } catch (err) { next(err); }
};

const placeOrder = async (req, res, next) => {
  try {
    const {
      items, location_id, delivery_type = 'delivery',
      delivery_address, delivery_latitude, delivery_longitude,
      coupon_code, special_instructions, payment_method
    } = req.body;

    const userId = req.user.id;
    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const productResult = await query(
        `SELECT p.*, ps.price as size_price, ps.size_name, ct.extra_price as crust_extra, ct.name as crust_name
         FROM Products p
         JOIN ProductSizes ps ON ps.id = ? AND ps.product_id = p.id
         LEFT JOIN CrustTypes ct ON ct.id = ?
         WHERE p.id = ? AND p.is_available = 1`,
        [item.size_id, item.crust_id || null, item.product_id]
      );
      if (!productResult.length) return badRequest(res, `Product not available`);
      const product = productResult[0];

      let itemPrice = product.size_price + (product.crust_extra || 0);
      const itemToppings = [];

      if (item.toppings && item.toppings.length) {
        for (const toppingId of item.toppings) {
          const tr = await query(`SELECT * FROM Toppings WHERE id = ? AND is_available = 1`, [toppingId]);
          if (tr.length) { itemPrice += tr[0].price; itemToppings.push(tr[0]); }
        }
      }

      const total_price = parseFloat((itemPrice * (item.quantity || 1)).toFixed(2));
      subtotal += total_price;
      orderItems.push({ ...item, product, unit_price: itemPrice, total_price, toppings: itemToppings });
    }

    const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 40 : 0);
    let discount_amount = 0;
    let couponId = null;

    if (coupon_code) {
      const couponResult = await query(
        `SELECT * FROM Coupons WHERE code = ? AND is_active = 1
         AND valid_from <= NOW() AND valid_until >= NOW()
         AND (usage_limit IS NULL OR used_count < usage_limit)`,
        [coupon_code]
      );
      if (!couponResult.length) return badRequest(res, 'Invalid coupon');
      const coupon = couponResult[0];
      if (subtotal < coupon.min_order_value) return badRequest(res, `Min order ₹${coupon.min_order_value} required`);
      discount_amount = coupon.discount_type === 'percentage'
        ? Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount || Infinity)
        : coupon.discount_value;
      couponId = coupon.id;
    }

    const taxable = subtotal - discount_amount + delivery_fee;
    const tax_amount = parseFloat((taxable * 0.05).toFixed(2));
    const total_amount = parseFloat((taxable + tax_amount).toFixed(2));
    const order_number = generateOrderNumber();

    const orderId = await transaction(async (conn) => {
      const [orderResult] = await conn.execute(
        `INSERT INTO Orders (order_number, user_id, location_id, delivery_type, delivery_address,
          delivery_latitude, delivery_longitude, subtotal, discount_amount, delivery_fee,
          tax_amount, total_amount, coupon_id, special_instructions, payment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [order_number, userId, location_id, delivery_type, delivery_address || null,
         delivery_latitude || null, delivery_longitude || null, subtotal, discount_amount,
         delivery_fee, tax_amount, total_amount, couponId, special_instructions || null]
      );
      const newOrderId = orderResult.insertId;

      for (const item of orderItems) {
        const [itemResult] = await conn.execute(
          `INSERT INTO OrderItems (order_id, product_id, product_name, size_id, size_name,
            crust_id, crust_name, quantity, unit_price, total_price, special_instructions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newOrderId, item.product_id, item.product.name, item.size_id, item.product.size_name,
           item.crust_id || null, item.product.crust_name || null, item.quantity || 1,
           item.unit_price, item.total_price, item.special_instructions || null]
        );
        const orderItemId = itemResult.insertId;
        for (const topping of item.toppings) {
          await conn.execute(
            `INSERT INTO OrderItemToppings (order_item_id, topping_id, topping_name, price) VALUES (?, ?, ?, ?)`,
            [orderItemId, topping.id, topping.name, topping.price]
          );
        }
      }

      await conn.execute(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?, 'pending', 'Order placed', ?, 'user')`,
        [newOrderId, userId]
      );

      if (couponId) {
        await conn.execute(`UPDATE Coupons SET used_count = used_count + 1 WHERE id = ?`, [couponId]);
        await conn.execute(`INSERT INTO UserCouponUsage (user_id, coupon_id, order_id) VALUES (?, ?, ?)`, [userId, couponId, newOrderId]);
      }

      return newOrderId;
    });

    return created(res, { order_id: orderId, order_number, total_amount }, 'Order placed successfully');
  } catch (err) { next(err); }
};

const getMyOrders = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = `WHERE o.user_id = ?`;
    const params = [req.user.id];

    if (status) { whereClause += ` AND o.status = ?`; params.push(status); }

    const countRes = await query(`SELECT COUNT(*) as total FROM Orders o ${whereClause}`, params);
    const result = await query(
      `SELECT o.*, l.name as location_name FROM Orders o
       LEFT JOIN Locations l ON o.location_id = l.id
       ${whereClause} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
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

    const [items, history, payment] = await Promise.all([
      query(`SELECT oi.*, p.image_url FROM OrderItems oi LEFT JOIN Products p ON oi.product_id = p.id WHERE oi.order_id = ?`, [order.id]),
      query(`SELECT * FROM OrderStatusHistory WHERE order_id = ? ORDER BY created_at ASC`, [order.id]),
      query(`SELECT payment_method, status, amount FROM Payments WHERE order_id = ?`, [order.id]),
    ]);

    for (const item of items) {
      item.toppings = await query(`SELECT * FROM OrderItemToppings WHERE order_item_id = ?`, [item.id]);
    }

    return success(res, { ...order, items, status_history: history, payment: payment[0] || null });
  } catch (err) { next(err); }
};

const cancelOrder = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const orderResult = await query(`SELECT * FROM Orders WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];

    if (!['pending', 'confirmed'].includes(order.status)) {
      return badRequest(res, 'Order cannot be cancelled at this stage');
    }

    await query(
      `UPDATE Orders SET status = 'cancelled', cancellation_reason = ?,
       cancellation_time = NOW(), cancelled_by = 'user', updated_at = NOW() WHERE id = ?`,
      [reason || 'Cancelled by user', order.id]
    );
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?, 'cancelled', ?, ?, 'user')`,
      [order.id, reason || 'Cancelled by user', req.user.id]
    );
    return success(res, {}, 'Order cancelled successfully');
  } catch (err) { next(err); }
};

const reorder = async (req, res, next) => {
  try {
    const orderResult = await query(
      `SELECT oi.product_id, oi.size_id, oi.crust_id, oi.quantity, oi.special_instructions,
              GROUP_CONCAT(CAST(oit.topping_id AS CHAR)) as topping_ids
       FROM OrderItems oi LEFT JOIN OrderItemToppings oit ON oit.order_item_id = oi.id
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

module.exports = { calculateOrder, placeOrder, getMyOrders, getOrderById, cancelOrder, reorder };
