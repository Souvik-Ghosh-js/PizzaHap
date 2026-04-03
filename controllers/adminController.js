const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { query, transaction } = require('../config/db');
const { success, created, badRequest, notFound, paginated, unauthorized } = require('../utils/response');
const { notifyUser, notifyAdmins, creditCoins, revertCoins } = require('../services/notificationService');
const { sendOrderStatusEmail, sendRiderAssignmentEmail } = require('../services/otpService');

// ── Auth ───────────────────────────────────────────────────────────
const adminLogin = async (req, res, next) => {
  try {
    const { email, password, location_id } = req.body;
    const rows = await query(`SELECT * FROM Admins WHERE email = ? AND is_active = 1`, [email]);
    if (!rows.length) return unauthorized(res, 'Invalid credentials');
    const admin = rows[0];
    if (!await bcrypt.compare(password, admin.password_hash)) return unauthorized(res, 'Invalid credentials');
    let resolvedLocationId = admin.location_id;
    if (admin.role === 'super_admin' && location_id) resolvedLocationId = parseInt(location_id);
    await query(`UPDATE Admins SET last_login = NOW() WHERE id = ?`, [admin.id]);
    const token = jwt.sign(
      { id: admin.id, type: 'admin', role: admin.role, location_id: resolvedLocationId },
      process.env.JWT_SECRET, { expiresIn: '12h' }
    );
    let locationName = null;
    if (resolvedLocationId) {
      const locRows = await query(`SELECT name FROM Locations WHERE id = ?`, [resolvedLocationId]);
      if (locRows.length) locationName = locRows[0].name;
    }
    const { password_hash, ...adminData } = admin;
    return success(res, { admin: { ...adminData, location_id: resolvedLocationId, location_name: locationName }, token });
  } catch (err) { next(err); }
};

// ── Dashboard ─────────────────────────────────────────────────────
const getDashboard = async (req, res, next) => {
  try {
    const lid = (req.admin.role === 'super_admin' && req.query.location_id !== undefined)
      ? (req.query.location_id ? parseInt(req.query.location_id) : null)
      : req.admin.location_id;
    const lf = lid ? ` AND location_id = ${parseInt(lid)}` : '';
    const olF = lid ? ` AND o.location_id = ${parseInt(lid)}` : '';
    const [todayOrders, totalRevenue, newUsers, pendingOrders, popularProducts] = await Promise.all([
      query(`SELECT COUNT(*) as count, IFNULL(SUM(total_amount),0) as revenue FROM Orders WHERE DATE(created_at) = CURDATE() AND payment_status = 'paid'${lf}`),
      query(`SELECT IFNULL(SUM(total_amount),0) as total FROM Orders WHERE payment_status = 'paid'${lf}`),
      query(`SELECT COUNT(*) as count FROM Users WHERE DATE(created_at) = CURDATE()`),
      query(`SELECT COUNT(*) as count FROM Orders WHERE status IN ('pending','confirmed','preparing')${lf}`),
      query(`SELECT p.name, p.image_url, COUNT(oi.id) as order_count, SUM(oi.total_price) as revenue FROM OrderItems oi JOIN Products p ON oi.product_id = p.id JOIN Orders o ON oi.order_id = o.id AND o.payment_status = 'paid'${olF} GROUP BY p.id ORDER BY order_count DESC LIMIT 5`),
    ]);
    return success(res, {
      today: { orders: todayOrders[0].count, revenue: todayOrders[0].revenue },
      total_revenue: totalRevenue[0].total,
      new_users_today: newUsers[0].count,
      pending_orders: pendingOrders[0].count,
      popular_products: popularProducts,
      location_id: lid || null,
    });
  } catch (err) { next(err); }
};

const getReports = async (req, res, next) => {
  try {
    const { period = 'daily', location_id } = req.query;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;
    const lf = lid ? ` AND location_id = ${parseInt(lid)}` : '';
    let groupBy;
    if (period === 'daily') groupBy = `DATE(created_at)`;
    else if (period === 'weekly') groupBy = `YEAR(created_at), WEEK(created_at)`;
    else groupBy = `DATE_FORMAT(created_at,'%Y-%m')`;
    const rows = await query(
      `SELECT ${groupBy} as period, COUNT(*) as total_orders, IFNULL(SUM(total_amount),0) as revenue,
              COUNT(CASE WHEN status='delivered' THEN 1 END) as delivered,
              COUNT(CASE WHEN status='cancelled' THEN 1 END) as cancelled
       FROM Orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)${lf}
       GROUP BY ${groupBy} ORDER BY MIN(created_at) DESC`
    );
    return success(res, rows);
  } catch (err) { next(err); }
};

// ── Orders ────────────────────────────────────────────────────────
const adminGetOrders = async (req, res, next) => {
  try {
    const { status, payment_status, location_id } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND o.status = ?'; params.push(status); }
    if (payment_status) { where += ' AND o.payment_status = ?'; params.push(payment_status); }
    if (lid) { where += ' AND o.location_id = ?'; params.push(lid); }
    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Orders o ${where}`, params),
      query(
        `SELECT o.*, u.name as user_name, u.mobile as user_mobile, l.name as location_name
         FROM Orders o
         LEFT JOIN Users u     ON o.user_id     = u.id
         LEFT JOIN Locations l ON o.location_id = l.id
         ${where} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
    ]);
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const adminGetOrderDetail = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;
    let where = `WHERE o.id = ?`;
    const params = [req.params.id];
    if (lid) { where += ` AND o.location_id = ?`; params.push(lid); }
    const orderResult = await query(
      `SELECT o.*, u.name as user_name, u.mobile as user_mobile, u.email as user_email,
              l.name as location_name, l.address as location_address
       FROM Orders o
       LEFT JOIN Users u     ON o.user_id     = u.id
       LEFT JOIN Locations l ON o.location_id = l.id
       ${where}`,
      params
    );
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];
    const [items, history, payment, feedback] = await Promise.all([
      query(`SELECT oi.*, p.image_url FROM OrderItems oi LEFT JOIN Products p ON oi.product_id = p.id WHERE oi.order_id = ?`, [order.id]),
      query(`SELECT osh.*, a.name as changed_by_name FROM OrderStatusHistory osh LEFT JOIN Admins a ON osh.changed_by = a.id AND osh.changed_by_role = 'admin' WHERE osh.order_id = ? ORDER BY osh.created_at ASC`, [order.id]),
      query(`SELECT * FROM Payments WHERE order_id = ?`, [order.id]),
      query(`SELECT * FROM OrderFeedback WHERE order_id = ?`, [order.id]),
    ]);
    for (const item of items) {
      item.toppings = await query(`SELECT * FROM OrderItemToppings WHERE order_item_id = ?`, [item.id]);
    }
    return success(res, { ...order, items, status_history: history, payment: payment[0] || null, feedback: feedback[0] || null });
  } catch (err) { next(err); }
};

const updateOrderStatus = async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const transitions = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['preparing', 'cancelled'],
      preparing: ['out_for_delivery', 'cancelled'],
      out_for_delivery: ['delivered'],
      delivered: ['refund_requested'],
      cancelled: [],
      refund_requested: ['refunded'],
      refunded: [],
    };
    const [orderRow] = await query(
      `SELECT o.*, u.email as user_email FROM Orders o
       LEFT JOIN Users u ON o.user_id = u.id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!orderRow) return notFound(res, 'Order not found');
    if (!transitions[orderRow.status]?.includes(status)) {
      return badRequest(res, `Cannot transition from '${orderRow.status}' to '${status}'`);
    }
    await query(`UPDATE Orders SET status = ?, updated_at = NOW() WHERE id = ?`, [status, req.params.id]);
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,?,?,?,'admin')`,
      [req.params.id, status, note || '', req.admin.id]
    );

    const statusMessages = {
      confirmed: 'Your order has been confirmed and will be prepared shortly.',
      preparing: 'Your order is being prepared!',
      out_for_delivery: 'Your order is on the way!',
      delivered: 'Your order has been delivered. Enjoy!',
      cancelled: 'Your order has been cancelled.',
    };
    if (orderRow.user_id && statusMessages[status]) {
      await notifyUser(orderRow.user_id, `Order ${status.replace(/_/g, ' ')}`, statusMessages[status], 'order',
        { order_id: orderRow.id, order_number: orderRow.order_number, status });
    }

    // Email notification for delivered/cancelled
    if (orderRow.user_email && ['delivered', 'cancelled'].includes(status)) {
      await sendOrderStatusEmail(orderRow.user_email, orderRow.order_number, status);
    }

    // Credit coins on delivery: 1 coin per Rs.10
    if (status === 'delivered' && orderRow.user_id) {
      const coinsEarned = Math.floor(orderRow.total_amount / 10);
      if (coinsEarned > 0) await creditCoins(orderRow.user_id, orderRow.id, coinsEarned);
    }

    return success(res, {}, 'Order status updated');
  } catch (err) { next(err); }
};

const updatePaymentStatus = async (req, res, next) => {
  try {
    const { payment_status, note } = req.body;
    const valid = ['pending', 'paid', 'failed', 'refunded'];
    if (!valid.includes(payment_status)) return badRequest(res, 'Invalid payment status');
    const [orderRow] = await query(`SELECT * FROM Orders WHERE id = ?`, [req.params.id]);
    if (!orderRow) return notFound(res, 'Order not found');
    const lid = req.admin.location_id;
    if (lid && orderRow.location_id !== lid) return notFound(res, 'Order not found');
    await query(`UPDATE Orders SET payment_status = ?, updated_at = NOW() WHERE id = ?`, [payment_status, req.params.id]);
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,?,?,?,'admin')`,
      [req.params.id, `payment_${payment_status}`, note || `Payment marked as ${payment_status}`, req.admin.id]
    );
    if (orderRow.user_id) {
      const msg = payment_status === 'paid' ? 'Payment confirmed for your order.' : `Payment status updated to: ${payment_status}`;
      await notifyUser(orderRow.user_id, 'Payment Update', msg, 'order', { order_id: orderRow.id, payment_status });
    }
    return success(res, {}, `Payment status updated to ${payment_status}`);
  } catch (err) { next(err); }
};

// ── In-house / admin billing ──────────────────────────────────────
const adminPlaceOrder = async (req, res, next) => {
  try {
    const {
      user_id, customer_name, customer_phone,
      items, location_id, delivery_type = 'pickup',
      delivery_address, special_instructions,
      payment_method = 'cash_on_delivery',
      coupon_code,
    } = req.body;

    const resolvedLocationId = req.admin.location_id || (location_id ? parseInt(location_id) : null);
    if (!resolvedLocationId) return badRequest(res, 'location_id is required');

    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      let productResult;

      // Handle products with sizes vs without sizes
      if (item.size_id) {
        // Product has a size - use location-aware pricing
        productResult = await query(
          `SELECT p.*, COALESCE(plp.price, ps.price) as size_price, ps.size_name,
                  COALESCE(clp.extra_price, ct.extra_price) as crust_extra, ct.name as crust_name
           FROM Products p
           JOIN ProductSizes ps ON ps.id = ? AND ps.product_id = p.id
           LEFT JOIN ProductLocationPricing plp ON plp.product_size_id = ps.id AND plp.location_id = ?
           LEFT JOIN CrustTypes ct ON ct.id = ?
           LEFT JOIN CrustLocationPricing clp ON clp.crust_id = ct.id AND clp.location_id = ?
           WHERE p.id = ? AND p.is_available = 1`,
          [item.size_id, resolvedLocationId, item.crust_id || null, resolvedLocationId, item.product_id]
        );
      } else {
        // Product doesn't have sizes - use base_price
        productResult = await query(
          `SELECT p.*, p.base_price as size_price, NULL as size_name,
                  COALESCE(clp.extra_price, ct.extra_price) as crust_extra, ct.name as crust_name
           FROM Products p
           LEFT JOIN CrustTypes ct ON ct.id = ?
           LEFT JOIN CrustLocationPricing clp ON clp.crust_id = ct.id AND clp.location_id = ?
           WHERE p.id = ? AND p.is_available = 1`,
          [item.crust_id || null, resolvedLocationId, item.product_id]
        );
      }

      if (!productResult.length) {
        console.log('Product not found with params:', {
          size_id: item.size_id,
          crust_id: item.crust_id,
          product_id: item.product_id
        });
        return badRequest(res, `Product ${item.product_id} not available`);
      }

      const product = productResult[0];

      // Stock check
      if (product.stock_quantity < (item.quantity || 1)) {
        return badRequest(res, `Insufficient stock for ${product.name}. Available: ${product.stock_quantity}`);
      }

      let itemPrice = parseFloat(product.size_price) + parseFloat(product.crust_extra || 0);
      const itemToppings = [];

      if (item.toppings?.length) {
        for (const tid of item.toppings) {
          const tr = await query(
            `SELECT t.*, COALESCE(tlp.price, t.price) as effective_price
             FROM Toppings t
             LEFT JOIN ToppingLocationPricing tlp ON tlp.topping_id = t.id AND tlp.location_id = ?
             WHERE t.id = ? AND t.is_available = 1`,
            [resolvedLocationId, tid]
          );
          if (tr.length) {
            itemPrice += parseFloat(tr[0].effective_price);
            itemToppings.push({ ...tr[0], price: tr[0].effective_price });
          }
        }
      }

      const total_price = parseFloat((itemPrice * (item.quantity || 1)).toFixed(2));
      subtotal += total_price;

      orderItems.push({
        ...item,
        product,
        unit_price: itemPrice,
        total_price,
        toppings: itemToppings
      });
    }

    subtotal = parseFloat(subtotal.toFixed(2));
    const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 40 : 0);//changed here delivery fee

    // ── Coupon discount ───────────────────────────────────────────
    let discount_amount = 0;
    let couponId = null;
    if (coupon_code) {
      const couponResult = await query(
        `SELECT * FROM Coupons WHERE code = ? AND is_active = 1
         AND valid_from <= NOW() AND valid_until >= NOW()
         AND (usage_limit IS NULL OR used_count < usage_limit)`,
        [coupon_code.toUpperCase()]
      );
      if (!couponResult.length) return badRequest(res, 'Invalid or expired coupon');
      const coupon = couponResult[0];
      if (subtotal < coupon.min_order_value) return badRequest(res, `Min order Rs.${coupon.min_order_value} required for this coupon`);
      if (coupon.discount_type === 'buy_1_get_1') {
        const applicableIds = coupon.applicable_product_ids
          ? (typeof coupon.applicable_product_ids === 'string' ? JSON.parse(coupon.applicable_product_ids) : coupon.applicable_product_ids)
          : [];
        const eligible = applicableIds.length > 0
          ? orderItems.filter(i => applicableIds.includes(i.product_id))
          : orderItems;
        if (!eligible.length) return badRequest(res, 'No eligible items for this BOGO coupon');
        discount_amount = parseFloat(Math.min(...eligible.map(i => i.unit_price)).toFixed(2));
      } else if (coupon.discount_type === 'percentage') {
        discount_amount = Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount || Infinity);
        discount_amount = parseFloat(discount_amount.toFixed(2));
      } else {
        discount_amount = parseFloat(parseFloat(coupon.discount_value).toFixed(2));
      }
      couponId = coupon.id;
    }

    // NO TAX
    const total_amount = parseFloat((subtotal - discount_amount + delivery_fee).toFixed(2));
    const order_number = `ADM-${Date.now().toString().slice(-6)}${Math.floor(1000 + Math.random() * 9000)}`;

    const orderId = await transaction(async (conn) => {
      const [orderResult] = await conn.execute(
        `INSERT INTO Orders
          (order_number, user_id, location_id, delivery_type,
           delivery_address, subtotal, discount_amount, delivery_fee,
           tax_amount, total_amount, coupon_id, special_instructions, payment_status, payment_method,
           customer_name, customer_phone)
         VALUES (?,?,?,?,?,?,?,?,0,?,?,?,'pending',?,?,?)`,
        [order_number, user_id || null, resolvedLocationId, delivery_type,
          delivery_address || null, subtotal, discount_amount, delivery_fee, total_amount,
          couponId || null, special_instructions || null, payment_method,
          customer_name || null, customer_phone || null]
      );
      const newOrderId = orderResult.insertId;

      for (const item of orderItems) {
        const [itemResult] = await conn.execute(
          `INSERT INTO OrderItems
            (order_id, product_id, product_name, size_id, size_name,
             crust_id, crust_name, quantity, unit_price, total_price)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [newOrderId, item.product_id, item.product.name, item.size_id || null,
            item.product.size_name || 'Regular', item.crust_id || null,
            item.product.crust_name || null, item.quantity || 1,
            parseFloat(item.unit_price).toFixed(2), item.total_price]
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

      if (couponId) {
        await conn.execute(`UPDATE Coupons SET used_count = used_count + 1 WHERE id = ?`, [couponId]);
        if (user_id) {
          await conn.execute(
            `INSERT INTO UserCouponUsage (user_id, coupon_id, order_id) VALUES (?,?,?)`,
            [user_id, couponId, newOrderId]
          );
        }
      }

      await conn.execute(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role)
         VALUES (?,'pending','In-house order created by admin',?,'admin')`,
        [newOrderId, req.admin.id]
      );

      // Auto-confirm in-house orders
      await conn.execute(
        `UPDATE Orders SET status = 'confirmed', updated_at = NOW() WHERE id = ?`, [newOrderId]
      );
      await conn.execute(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role)
         VALUES (?,'confirmed','Auto-confirmed in-house order',?,'admin')`,
        [newOrderId, req.admin.id]
      );

      // Mark COD as paid immediately for in-house
      if (payment_method === 'cash_on_delivery') {
        await conn.execute(
          `INSERT INTO Payments (order_id, payment_method, amount, status) VALUES (?, 'cash_on_delivery', ?, 'captured')`,
          [newOrderId, total_amount]
        );
        await conn.execute(
          `UPDATE Orders SET payment_status = 'paid', updated_at = NOW() WHERE id = ?`, [newOrderId]
        );
      }

      return newOrderId;
    });

    if (user_id) {
      await notifyUser(user_id, 'Order Created',
        `An order ${order_number} has been created for you. Total: Rs.${total_amount}`,
        'order', { order_id: orderId, order_number });
    }

    return created(res, { order_id: orderId, order_number, subtotal, discount_amount, total_amount, payment_method }, 'In-house order created');
  } catch (err) {
    console.error('Order placement error:', err);
    next(err);
  }
};

// ── Users ─────────────────────────────────────────────────────────
const adminGetUsers = async (req, res, next) => {
  try {
    const { search, is_blocked } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params = [];
    if (search) { where += ` AND (name LIKE ? OR email LIKE ? OR mobile LIKE ?)`; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (is_blocked !== undefined) { where += ` AND is_blocked = ?`; params.push(is_blocked === 'true' ? 1 : 0); }
    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Users ${where}`, params),
      query(
        `SELECT u.id, u.name, u.email, u.mobile, u.is_verified, u.is_active, u.is_blocked,
                u.created_at, u.last_login, u.address_house, u.address_town,
                u.address_state, u.address_pincode, COALESCE(uc.balance,0) as coin_balance
         FROM Users u LEFT JOIN UserCoins uc ON uc.user_id = u.id
         ${where} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
    ]);
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const blockUser = async (req, res, next) => {
  try {
    const { is_blocked } = req.body;
    await query(`UPDATE Users SET is_blocked = ? WHERE id = ?`, [is_blocked ? 1 : 0, req.params.id]);
    return success(res, {}, `User ${is_blocked ? 'blocked' : 'unblocked'}`);
  } catch (err) { next(err); }
};

// ── Categories CRUD ───────────────────────────────────────────────
const adminGetCategories = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM Categories ORDER BY sort_order, name`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createCategory = async (req, res, next) => {
  try {
    const { name, description, sort_order = 0, has_toppings = 0, has_crust = 0 } = req.body;
    const r = await query(
      `INSERT INTO Categories (name, description, sort_order, has_toppings, has_crust) VALUES (?,?,?,?,?)`,
      [name, description || null, sort_order, has_toppings ? 1 : 0, has_crust ? 1 : 0]
    );
    return created(res, { category_id: r.insertId }, 'Category created');
  } catch (err) { next(err); }
};

const updateCategory = async (req, res, next) => {
  try {
    const { name, description, sort_order, has_toppings, has_crust, is_active } = req.body;
    await query(
      `UPDATE Categories SET
         name         = IFNULL(?,name),
         description  = IFNULL(?,description),
         sort_order   = IFNULL(?,sort_order),
         has_toppings = IFNULL(?,has_toppings),
         has_crust    = IFNULL(?,has_crust),
         is_active    = IFNULL(?,is_active)
       WHERE id = ?`,
      [
        name || null, description || null,
        sort_order != null ? sort_order : null,
        has_toppings != null ? (has_toppings ? 1 : 0) : null,
        has_crust != null ? (has_crust ? 1 : 0) : null,
        is_active != null ? (is_active ? 1 : 0) : null,
        req.params.id,
      ]
    );
    return success(res, {}, 'Category updated');
  } catch (err) { next(err); }
};

const deleteCategory = async (req, res, next) => {
  try {
    const categoryId = req.params.id;
    // Check if category has any products
    const products = await query(`SELECT id FROM Products WHERE category_id = ? AND is_available = 1`, [categoryId]);
    if (products.length > 0) {
      return badRequest(res, 'Cannot delete category with active products. Please remove or disable products first.');
    }
    await query(`UPDATE Categories SET is_active = 0 WHERE id = ?`, [categoryId]);
    return success(res, {}, 'Category deactivated');
  } catch (err) { next(err); }
};

const uploadCategoryImage = async (req, res, next) => {
  try {
    if (!req.file) return badRequest(res, 'No image file provided');
    const imageUrl = `/uploads/categories/${req.file.filename}`;
    await query(`UPDATE Categories SET image_url = ? WHERE id = ?`, [imageUrl, req.params.id]);
    const base = process.env.BASE_URL || process.env.APP_URL || 'http://localhost:3000';
    return success(res, { image_url: `${base}${imageUrl}` }, 'Image uploaded');
  } catch (err) { next(err); }
};

// ── Products CRUD ─────────────────────────────────────────────────
const adminGetProducts = async (req, res, next) => {
  try {
    const { search, category_id, show_unavailable, location_id } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;
    let where = 'WHERE 1=1';
    const params = [];
    if (show_unavailable !== 'true') { where += ` AND p.is_available = 1`; }
    if (category_id) { where += ` AND p.category_id = ?`; params.push(parseInt(category_id)); }
    if (search) { where += ` AND (p.name LIKE ? OR p.description LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }

    const lidSql = lid ? parseInt(lid) : 'NULL';
    const locPriceSelect = `,
              (
                SELECT COALESCE(MIN(COALESCE(plp.price, ps.price)), p.base_price)
                FROM ProductSizes ps
                LEFT JOIN ProductLocationPricing plp ON plp.product_size_id = ps.id AND plp.location_id = ${lidSql}
                WHERE ps.product_id = p.id AND ps.is_available = 1
              ) as min_price`;

    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Products p ${where}`, params),
      query(
        `SELECT p.*, c.name as category_name, 1 as location_available${locPriceSelect}
         FROM Products p
         LEFT JOIN Categories c ON p.category_id = c.id
         ${where}
         ORDER BY p.category_id, p.sort_order, p.name
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
    ]);

    const processedRows = rows.map(r => ({
      ...r,
      base_price: r.min_price !== null ? r.min_price : r.base_price
    }));

    return paginated(res, processedRows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const createProduct = async (req, res, next) => {
  try {
    const { category_id, name, description, base_price, is_veg, is_featured, stock_quantity = 0, sizes } = req.body;
    const r = await query(
      `INSERT INTO Products (category_id, name, description, base_price, is_veg, is_featured, stock_quantity) VALUES (?,?,?,?,?,?,?)`,
      [category_id, name, description || null, parseFloat(base_price), is_veg ? 1 : 0, is_featured ? 1 : 0, stock_quantity]
    );
    const productId = r.insertId;
    if (sizes?.length) {
      for (const sz of sizes) {
        await query(`INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`,
          [productId, sz.size_name, sz.size_code || sz.size_name.slice(0, 3).toUpperCase(), parseFloat(sz.price)]);
      }
    } else {
      await query(`INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`,
        [productId, 'Regular', 'REG', parseFloat(base_price)]);
    }
    return created(res, { product_id: productId }, 'Product created');
  } catch (err) { next(err); }
};

const updateProduct = async (req, res, next) => {
  try {
    const { name, description, base_price, is_veg, is_featured, is_available, category_id, stock_quantity } = req.body;
    await query(
      `UPDATE Products SET
         name          = IFNULL(?,name),
         description   = IFNULL(?,description),
         base_price    = IFNULL(?,base_price),
         is_veg        = IFNULL(?,is_veg),
         is_featured   = IFNULL(?,is_featured),
         is_available  = IFNULL(?,is_available),
         category_id   = IFNULL(?,category_id),
         stock_quantity= IFNULL(?,stock_quantity),
         updated_at    = NOW()
       WHERE id = ?`,
      [
        name || null, description || null,
        base_price != null ? parseFloat(base_price) : null,
        is_veg != null ? (is_veg ? 1 : 0) : null,
        is_featured != null ? (is_featured ? 1 : 0) : null,
        is_available != null ? (is_available ? 1 : 0) : null,
        category_id != null ? parseInt(category_id) : null,
        stock_quantity != null ? parseInt(stock_quantity) : null,
        req.params.id,
      ]
    );
    return success(res, {}, 'Product updated');
  } catch (err) { next(err); }
};

const deleteProduct = async (req, res, next) => {
  try {
    await query(`UPDATE Products SET is_available = 0 WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Product removed from menu');
  } catch (err) { next(err); }
};

const uploadProductImage = async (req, res, next) => {
  try {
    if (!req.file) return badRequest(res, 'No image file provided');
    const [product] = await query(`SELECT id, image_url FROM Products WHERE id = ?`, [req.params.id]);
    if (!product) return notFound(res, 'Product not found');
    if (product.image_url) {
      const oldPath = path.join(__dirname, '..', product.image_url.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) { } }
    }
    const imageUrl = `/uploads/products/${req.file.filename}`;
    await query(`UPDATE Products SET image_url = ?, updated_at = NOW() WHERE id = ?`, [imageUrl, req.params.id]);
    const base = process.env.BASE_URL || process.env.APP_URL || 'http://localhost:3000';
    return success(res, { image_url: `${base}${imageUrl}` }, 'Image uploaded');
  } catch (err) { next(err); }
};

const setProductLocationAvailability = async (req, res, next) => {
  try {
    const { is_available, location_id: bodyLocId } = req.body;
    const productId = parseInt(req.params.id);
    const locationId = req.admin.location_id || (bodyLocId ? parseInt(bodyLocId) : null);
    if (!locationId) return badRequest(res, 'location_id is required');
    await query(
      `INSERT INTO ProductLocationAvailability (product_id, location_id, is_available) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE is_available = VALUES(is_available), updated_at = NOW()`,
      [productId, locationId, is_available ? 1 : 0]
    );
    return success(res, {}, `Product ${is_available ? 'enabled' : 'disabled'} at this location`);
  } catch (err) { next(err); }
};

const getProductAvailabilityMatrix = async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const locations = await query(`SELECT id, name FROM Locations WHERE is_active = 1 ORDER BY name`);
    const avails = await query(`SELECT location_id, is_available FROM ProductLocationAvailability WHERE product_id = ?`, [productId]);
    const map = Object.fromEntries(avails.map(r => [r.location_id, r.is_available]));
    const matrix = locations.map(loc => ({
      location_id: loc.id, location_name: loc.name,
      is_available: map[loc.id] !== undefined ? map[loc.id] === 1 : true,
    }));
    return success(res, matrix);
  } catch (err) { next(err); }
};

// ── Product Sizes CRUD ────────────────────────────────────────────
const adminGetProductSizes = async (req, res, next) => {
  try {
    const lid = req.admin.location_id || (req.query.location_id ? parseInt(req.query.location_id) : null);
    
    // 1. Get sizes
    let rows;
    if (lid) {
      rows = await query(
        `SELECT ps.*, COALESCE(plp.price, ps.price) as price, COALESCE(plp.price, ps.price) as effective_price
         FROM ProductSizes ps
         LEFT JOIN ProductLocationPricing plp ON plp.product_size_id = ps.id AND plp.location_id = ?
         WHERE ps.product_id = ? ORDER BY ps.price`,
        [lid, req.params.id]
      );
    } else {
      rows = await query(`SELECT *, price as effective_price FROM ProductSizes WHERE product_id = ? ORDER BY price`, [req.params.id]);
    }

    // 2. Get crust/topping size matrix for this branch
    const [crustPricing, toppingPricing] = await Promise.all([
      lid ? query(
        `SELECT csp.crust_id, csp.size_code, COALESCE(clsp.extra_price, csp.extra_price) as extra_price
         FROM CrustSizePricing csp
         LEFT JOIN CrustLocationSizePricing clsp ON clsp.crust_id = csp.crust_id AND clsp.size_code = csp.size_code AND clsp.location_id = ?`,
        [lid]
      ) : query(`SELECT crust_id, size_code, extra_price FROM CrustSizePricing`),
      
      lid ? query(
        `SELECT tsp.topping_id, tsp.size_code, COALESCE(tlsp.price, tsp.price) as price
         FROM ToppingSizePricing tsp
         LEFT JOIN ToppingLocationSizePricing tlsp ON tlsp.topping_id = tsp.topping_id AND tlsp.size_code = tsp.size_code AND tlsp.location_id = ?`,
        [lid]
      ) : query(`SELECT topping_id, size_code, price FROM ToppingSizePricing`)
    ]);

    return success(res, {
      sizes: rows,
      crust_pricing: crustPricing,
      topping_pricing: toppingPricing
    });
  } catch (err) { next(err); }
};

const createProductSize = async (req, res, next) => {
  try {
    const { size_name, size_code, price } = req.body;
    const r = await query(
      `INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`,
      [req.params.id, size_name, size_code || size_name.slice(0, 3).toUpperCase(), parseFloat(price)]
    );
    return created(res, { size_id: r.insertId }, 'Size added');
  } catch (err) { next(err); }
};

const updateProductSize = async (req, res, next) => {
  try {
    const { size_name, size_code, price, is_available } = req.body;
    await query(
      `UPDATE ProductSizes SET
         size_name    = IFNULL(?,size_name),
         size_code    = IFNULL(?,size_code),
         price        = IFNULL(?,price),
         is_available = IFNULL(?,is_available)
       WHERE id = ? AND product_id = ?`,
      [
        size_name || null, size_code || null,
        price != null ? parseFloat(price) : null,
        is_available != null ? (is_available ? 1 : 0) : null,
        req.params.sizeId, req.params.id,
      ]
    );
    return success(res, {}, 'Size updated');
  } catch (err) { next(err); }
};

const deleteProductSize = async (req, res, next) => {
  try {
    await query(`DELETE FROM ProductSizes WHERE id = ? AND product_id = ?`, [req.params.sizeId, req.params.id]);
    return success(res, {}, 'Size deleted');
  } catch (err) { next(err); }
};

// ── Toppings CRUD ─────────────────────────────────────────────────
const adminGetToppings = async (req, res, next) => {
  try {
    const lid = req.admin.location_id || (req.query.location_id ? parseInt(req.query.location_id) : null);
    if (lid) {
      const rows = await query(
        `SELECT t.*, COALESCE(tlp.price, t.price) as price, COALESCE(tlp.price, t.price) as effective_price
         FROM Toppings t
         LEFT JOIN ToppingLocationPricing tlp ON tlp.topping_id = t.id AND tlp.location_id = ?
         ORDER BY t.sort_order, t.name`,
        [lid]
      );
      return success(res, rows);
    }
    const rows = await query(`SELECT *, price as effective_price FROM Toppings ORDER BY sort_order, name`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createTopping = async (req, res, next) => {
  try {
    const { name, price, is_veg = 1, sort_order = 0 } = req.body;
    const r = await query(
      `INSERT INTO Toppings (name, price, is_veg, sort_order) VALUES (?,?,?,?)`,
      [name, parseFloat(price), is_veg ? 1 : 0, sort_order]
    );
    return created(res, { topping_id: r.insertId }, 'Topping created');
  } catch (err) { next(err); }
};

const updateTopping = async (req, res, next) => {
  try {
    const { name, price, is_veg, is_available, sort_order } = req.body;
    await query(
      `UPDATE Toppings SET
         name         = IFNULL(?,name),
         price        = IFNULL(?,price),
         is_veg       = IFNULL(?,is_veg),
         is_available = IFNULL(?,is_available),
         sort_order   = IFNULL(?,sort_order)
       WHERE id = ?`,
      [
        name || null,
        price != null ? parseFloat(price) : null,
        is_veg != null ? (is_veg ? 1 : 0) : null,
        is_available != null ? (is_available ? 1 : 0) : null,
        sort_order != null ? sort_order : null,
        req.params.id,
      ]
    );
    return success(res, {}, 'Topping updated');
  } catch (err) { next(err); }
};

const deleteTopping = async (req, res, next) => {
  try {
    await query(`UPDATE Toppings SET is_available = 0 WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Topping disabled');
  } catch (err) { next(err); }
};

// ── Crust Types CRUD ──────────────────────────────────────────────
const adminGetCrusts = async (req, res, next) => {
  try {
    const lid = req.admin.location_id || (req.query.location_id ? parseInt(req.query.location_id) : null);
    if (lid) {
      const rows = await query(
        `SELECT c.*, COALESCE(clp.extra_price, c.extra_price) as extra_price, COALESCE(clp.extra_price, c.extra_price) as effective_extra_price
         FROM CrustTypes c
         LEFT JOIN CrustLocationPricing clp ON clp.crust_id = c.id AND clp.location_id = ?
         ORDER BY c.sort_order, c.name`,
        [lid]
      );
      return success(res, rows);
    }
    const rows = await query(`SELECT *, extra_price as effective_extra_price FROM CrustTypes ORDER BY sort_order, name`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createCrust = async (req, res, next) => {
  try {
    const { name, extra_price = 0, sort_order = 0 } = req.body;
    const r = await query(
      `INSERT INTO CrustTypes (name, extra_price, sort_order) VALUES (?,?,?)`,
      [name, parseFloat(extra_price), sort_order]
    );
    return created(res, { crust_id: r.insertId }, 'Crust type created');
  } catch (err) { next(err); }
};

const updateCrust = async (req, res, next) => {
  try {
    const { name, extra_price, is_available, sort_order } = req.body;
    await query(
      `UPDATE CrustTypes SET
         name         = IFNULL(?,name),
         extra_price  = IFNULL(?,extra_price),
         is_available = IFNULL(?,is_available),
         sort_order   = IFNULL(?,sort_order)
       WHERE id = ?`,
      [
        name || null,
        extra_price != null ? parseFloat(extra_price) : null,
        is_available != null ? (is_available ? 1 : 0) : null,
        sort_order != null ? sort_order : null,
        req.params.id,
      ]
    );
    return success(res, {}, 'Crust type updated');
  } catch (err) { next(err); }
};

const deleteCrust = async (req, res, next) => {
  try {
    await query(`UPDATE CrustTypes SET is_available = 0 WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Crust type disabled');
  } catch (err) { next(err); }
};

// ── Locations CRUD ────────────────────────────────────────────────
const adminGetLocations = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM Locations ORDER BY name`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createLocation = async (req, res, next) => {
  try {
    const { name, address, city, latitude, longitude, phone, email, opening_time, closing_time } = req.body;
    const r = await query(
      `INSERT INTO Locations (name, address, city, latitude, longitude, phone, email, opening_time, closing_time)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [name, address, city || '', latitude, longitude, phone || null, email || null,
        opening_time || '09:00:00', closing_time || '23:00:00']
    );
    return created(res, { location_id: r.insertId }, 'Location created');
  } catch (err) { next(err); }
};

const updateLocation = async (req, res, next) => {
  try {
    const { name, address, city, latitude, longitude, phone, email, is_active, opening_time, closing_time } = req.body;
    await query(
      `UPDATE Locations SET
         name         = IFNULL(?,name), address      = IFNULL(?,address),
         city         = IFNULL(?,city), latitude     = IFNULL(?,latitude),
         longitude    = IFNULL(?,longitude), phone   = IFNULL(?,phone),
         email        = IFNULL(?,email),
         is_active    = IFNULL(?,is_active),
         opening_time = IFNULL(?,opening_time), closing_time = IFNULL(?,closing_time)
       WHERE id = ?`,
      [name || null, address || null, city || null, latitude || null, longitude || null,
      phone || null, email || null, is_active != null ? (is_active ? 1 : 0) : null,
      opening_time || null, closing_time || null, req.params.id]
    );
    return success(res, {}, 'Location updated');
  } catch (err) { next(err); }
};

// ── Delivery Riders CRUD ──────────────────────────────────────────
const getDeliveryRiders = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;
    let where = 'WHERE 1=1';
    const params = [];
    if (lid) { where += ' AND location_id = ?'; params.push(lid); }
    const rows = await query(
      `SELECT dr.*, l.name as location_name FROM DeliveryRiders dr LEFT JOIN Locations l ON dr.location_id = l.id ${where} ORDER BY dr.name ASC`,
      params
    );
    return success(res, rows);
  } catch (err) { next(err); }
};

const createDeliveryRider = async (req, res, next) => {
  try {
    const { name, phone, email, location_id } = req.body;
    const resolvedLocationId = req.admin.location_id || (location_id ? parseInt(location_id) : null);
    await query(
      `INSERT INTO DeliveryRiders (name, phone, email, location_id) VALUES (?,?,?,?)`,
      [name.trim(), phone.trim(), email ? email.trim() : null, resolvedLocationId]
    );
    return created(res, {}, 'Delivery rider added');
  } catch (err) { next(err); }
};

const updateDeliveryRider = async (req, res, next) => {
  try {
    const { name, phone, email, is_active, location_id } = req.body;
    await query(
      `UPDATE DeliveryRiders SET
         name        = IFNULL(?,name),
         phone       = IFNULL(?,phone),
         email       = IFNULL(?,email),
         is_active   = IFNULL(?,is_active),
         location_id = IFNULL(?,location_id),
         updated_at  = NOW()
       WHERE id = ?`,
      [name || null, phone || null, email || null,
      is_active != null ? (is_active ? 1 : 0) : null,
      location_id ? parseInt(location_id) : null,
      req.params.id]
    );
    return success(res, {}, 'Delivery rider updated');
  } catch (err) { next(err); }
};

const deleteDeliveryRider = async (req, res, next) => {
  try {
    await query(`UPDATE DeliveryRiders SET is_active = 0 WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Delivery rider deactivated');
  } catch (err) { next(err); }
};

const assignRiderToOrder = async (req, res, next) => {
  try {
    const { rider_id } = req.body;
    const orderId = req.params.id;

    if (rider_id) {
      const riderRows = await query(`SELECT * FROM DeliveryRiders WHERE id = ? AND is_active = 1`, [rider_id]);
      if (!riderRows.length) return notFound(res, 'Rider not found or inactive');
    }

    await query(
      `UPDATE Orders SET rider_id = ?, updated_at = NOW() WHERE id = ?`,
      [rider_id || null, orderId]
    );

    if (rider_id) {
      const [rider] = await query(`SELECT name, email FROM DeliveryRiders WHERE id = ?`, [rider_id]);
      const [order] = await query(`SELECT order_number, delivery_address FROM Orders WHERE id = ?`, [orderId]);

      await query(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role)
         SELECT ?, status, CONCAT('Rider assigned: ', ?), ?, 'admin' FROM Orders WHERE id = ?`,
        [orderId, rider.name, req.admin.id, orderId]
      );

      // Send email to rider
      if (rider.email) {
        await sendRiderAssignmentEmail(rider.email, rider.name, order.order_number, order.delivery_address || 'Pickup');
      }
    }

    return success(res, {}, rider_id ? 'Rider assigned to order' : 'Rider unassigned from order');
  } catch (err) { next(err); }
};

// ── Coupons CRUD ──────────────────────────────────────────────────
const adminGetCoupons = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM Coupons ORDER BY created_at DESC`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createCoupon = async (req, res, next) => {
  try {
    const { code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, per_user_limit, valid_from, valid_until, applicable_product_ids } = req.body;
    // buy_1_get_1 coupons don't need a discount_value (stored as 0)
    const resolvedDiscountValue = discount_type === 'buy_1_get_1' ? 0 : (discount_value || 0);
    // applicable_product_ids: array of product IDs or null/empty = all products
    const productIds = Array.isArray(applicable_product_ids) && applicable_product_ids.length > 0
      ? JSON.stringify(applicable_product_ids.map(Number))
      : null;
    await query(
      `INSERT INTO Coupons (code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, per_user_limit, valid_from, valid_until, applicable_product_ids)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [code.toUpperCase(), description || null, discount_type, resolvedDiscountValue,
      min_order_value || 0, max_discount || null, usage_limit || null,
      per_user_limit || 1, new Date(valid_from), new Date(valid_until), productIds]
    );
    return created(res, {}, 'Coupon created');
  } catch (err) { next(err); }
};

const updateCoupon = async (req, res, next) => {
  try {
    const { is_active, description, discount_value, min_order_value, max_discount, usage_limit, valid_until } = req.body;
    await query(
      `UPDATE Coupons SET
         is_active       = IFNULL(?,is_active),
         description     = IFNULL(?,description),
         discount_value  = IFNULL(?,discount_value),
         min_order_value = IFNULL(?,min_order_value),
         max_discount    = IFNULL(?,max_discount),
         usage_limit     = IFNULL(?,usage_limit),
         valid_until     = IFNULL(?,valid_until)
       WHERE id = ?`,
      [
        is_active != null ? (is_active ? 1 : 0) : null,
        description || null, discount_value || null,
        min_order_value || null, max_discount || null, usage_limit || null,
        valid_until ? new Date(valid_until) : null,
        req.params.id,
      ]
    );
    return success(res, {}, 'Coupon updated');
  } catch (err) { next(err); }
};

// ── Accept / Reject Order ────────────────────────────────────────
const acceptRejectOrder = async (req, res, next) => {
  try {
    const { action, reason, location_id } = req.body;
    if (!['accept', 'reject'].includes(action)) return badRequest(res, 'action must be accept or reject');
    const orderId = req.params.id;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;
    let where = `WHERE o.id = ?`;
    const params = [orderId];
    if (lid) { where += ` AND o.location_id = ?`; params.push(lid); }
    const [orderRow] = await query(
      `SELECT o.*, u.email as user_email FROM Orders o
       LEFT JOIN Users u ON o.user_id = u.id
       ${where}`,
      params
    );
    if (!orderRow) return notFound(res, 'Order not found');
    if (orderRow.status !== 'pending') return badRequest(res, 'Can only accept/reject pending orders');

    if (action === 'accept') {
      await query(`UPDATE Orders SET status = 'confirmed', updated_at = NOW() WHERE id = ?`, [orderId]);
      await query(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,'confirmed',?,?,'admin')`,
        [orderId, reason || 'Order accepted by admin', req.admin.id]
      );
      if (orderRow.user_id) {
        await notifyUser(orderRow.user_id, 'Order Accepted!',
          `Your order ${orderRow.order_number} has been accepted and will be prepared shortly.`,
          'order', { order_id: orderRow.id, order_number: orderRow.order_number, status: 'confirmed' });
      }
      return success(res, {}, 'Order accepted');
    } else {
      const cancelReason = reason || 'Rejected by admin';
      await transaction(async (conn) => {
        await conn.execute(
          `UPDATE Orders SET status = 'cancelled', cancellation_reason = ?, cancellation_time = NOW(), cancelled_by = 'admin', updated_at = NOW() WHERE id = ?`,
          [cancelReason, orderId]
        );
        await conn.execute(
          `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,'cancelled',?,?,'admin')`,
          [orderId, cancelReason, req.admin.id]
        );
        // Refund coins if any were redeemed
        if (orderRow.coins_redeemed > 0) {
          await conn.execute(
            `INSERT INTO UserCoins (user_id, balance) VALUES (?,?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), updated_at = NOW()`,
            [orderRow.user_id, orderRow.coins_redeemed]
          );
          await conn.execute(
            `INSERT INTO CoinTransactions (user_id, order_id, type, coins, description) VALUES (?,?,'reverted',?,'Order rejected by admin - coins restored')`,
            [orderRow.user_id, orderId, orderRow.coins_redeemed]
          );
        }
      });
      if (orderRow.user_id) {
        await notifyUser(orderRow.user_id, 'Order Rejected',
          `Sorry, your order ${orderRow.order_number} was rejected. Reason: ${cancelReason}`,
          'order', { order_id: orderRow.id, order_number: orderRow.order_number, status: 'cancelled' });

        // Email notification
        if (orderRow.user_email) {
          await sendOrderStatusEmail(orderRow.user_email, orderRow.order_number, 'cancelled');
        }
      }
      return success(res, {}, 'Order rejected');
    }
  } catch (err) { next(err); }
};

// ── Reviews / Feedback ────────────────────────────────────────────
const adminGetReviews = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { min_rating, max_rating, location_id } = req.query;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;
    let where = 'WHERE 1=1';
    const params = [];
    if (lid) { where += ' AND o.location_id = ?'; params.push(lid); }
    if (min_rating) { where += ' AND f.overall_rating >= ?'; params.push(parseInt(min_rating)); }
    if (max_rating) { where += ' AND f.overall_rating <= ?'; params.push(parseInt(max_rating)); }
    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM OrderFeedback f JOIN Orders o ON f.order_id = o.id ${where}`, params),
      query(
        `SELECT f.id, f.order_id, f.food_rating, f.delivery_rating, f.overall_rating, f.comment, f.created_at,
                o.order_number, o.location_id,
                u.name as user_name, u.mobile as user_mobile,
                l.name as location_name
         FROM OrderFeedback f
         JOIN Orders o ON f.order_id = o.id
         JOIN Users  u ON f.user_id  = u.id
         LEFT JOIN Locations l ON o.location_id = l.id
         ${where}
         ORDER BY f.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
    ]);
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

// ── Admin Notifications ───────────────────────────────────────────
const getAdminNotifications = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    const lid = (req.admin.role === 'super_admin' && location_id !== undefined)
      ? (location_id ? parseInt(location_id) : null)
      : req.admin.location_id;

    let where = 'WHERE 1=1';
    const params = [];
    if (lid) {
      // Branch-specific mode: Show only notifications for this location or dedicated to this admin
      where += ` AND (an.location_id = ? OR (an.location_id IS NULL AND an.admin_id = ?))`;
      params.push(lid, req.admin.id);
    } else {
      // All Branches mode: Show all notifications except specifically for other admins
      where += ` AND (an.admin_id = ? OR an.admin_id IS NULL)`;
      params.push(req.admin.id);
    }
    const rows = await query(
      `SELECT an.* FROM AdminNotifications an ${where} ORDER BY an.created_at DESC LIMIT 100`, params
    );
    const unread = rows.filter(n => !n.is_read).length;
    return success(res, { notifications: rows, unread_count: unread });
  } catch (err) { next(err); }
};

const markAdminNotifRead = async (req, res, next) => {
  try {
    await query(`UPDATE AdminNotifications SET is_read = 1 WHERE id = ? AND admin_id = ?`, [req.params.id, req.admin.id]);
    return success(res, {}, 'Notification marked as read');
  } catch (err) { next(err); }
};

const markAllAdminNotifsRead = async (req, res, next) => {
  try {
    await query(`UPDATE AdminNotifications SET is_read = 1 WHERE admin_id = ? AND is_read = 0`, [req.admin.id]);
    return success(res, {}, 'All notifications marked as read');
  } catch (err) { next(err); }
};

const sendNotificationToUsers = async (req, res, next) => {
  try {
    const { title, message, type = 'promo', user_ids } = req.body;
    let users;
    if (user_ids?.length) {
      users = await query(
        `SELECT id FROM Users WHERE id IN (${user_ids.map(() => '?').join(',')}) AND is_active = 1`, user_ids
      );
    } else {
      users = await query(`SELECT id FROM Users WHERE is_active = 1 AND is_blocked = 0`);
    }
    let count = 0;
    for (const u of users) {
      await query(`INSERT INTO Notifications (user_id, title, message, type) VALUES (?,?,?,?)`, [u.id, title, message, type]);
      count++;
    }
    return success(res, { sent_to: count }, `Notification sent to ${count} users`);
  } catch (err) { next(err); }
};

// ── Banners CRUD ─────────────────────────────────────────────────
const adminGetBanners = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM Banners ORDER BY sort_order, id`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createBanner = async (req, res, next) => {
  try {
    const { badge_text, title_text, gradient_start, gradient_end, icon_name, sort_order, is_active, valid_from, valid_until } = req.body;
    const r = await query(
      `INSERT INTO Banners (badge_text, title_text, gradient_start, gradient_end, icon_name, sort_order, is_active, valid_from, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [badge_text, title_text, gradient_start || '#991515', gradient_end || '#FF6B35',
       icon_name || 'local_offer', sort_order || 0, is_active != null ? (is_active ? 1 : 0) : 1,
       valid_from || null, valid_until || null]
    );
    return created(res, { banner_id: r.insertId }, 'Banner created');
  } catch (err) { next(err); }
};

const updateBanner = async (req, res, next) => {
  try {
    const { badge_text, title_text, gradient_start, gradient_end, icon_name, sort_order, is_active, valid_from, valid_until } = req.body;
    await query(
      `UPDATE Banners SET
         badge_text     = IFNULL(?,badge_text),
         title_text     = IFNULL(?,title_text),
         gradient_start = IFNULL(?,gradient_start),
         gradient_end   = IFNULL(?,gradient_end),
         icon_name      = IFNULL(?,icon_name),
         sort_order     = IFNULL(?,sort_order),
         is_active      = IFNULL(?,is_active),
         valid_from     = ?,
         valid_until    = ?
       WHERE id = ?`,
      [badge_text || null, title_text || null, gradient_start || null, gradient_end || null,
       icon_name || null, sort_order != null ? sort_order : null,
       is_active != null ? (is_active ? 1 : 0) : null,
       valid_from || null, valid_until || null, req.params.id]
    );
    return success(res, {}, 'Banner updated');
  } catch (err) { next(err); }
};

const deleteBanner = async (req, res, next) => {
  try {
    await query(`DELETE FROM Banners WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Banner deleted');
  } catch (err) { next(err); }
};

// ── Location Geofences ───────────────────────────────────────────
const getLocationGeofence = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM LocationGeofences WHERE location_id = ?`, [req.params.id]);
    return success(res, rows.length ? rows[0] : null);
  } catch (err) { next(err); }
};

const saveLocationGeofence = async (req, res, next) => {
  try {
    const { polygon_coordinates } = req.body;
    if (!polygon_coordinates || !Array.isArray(polygon_coordinates) || polygon_coordinates.length < 3) {
      return badRequest(res, 'At least 3 polygon points required');
    }
    await query(
      `INSERT INTO LocationGeofences (location_id, polygon_coordinates)
       VALUES (?, ?) ON DUPLICATE KEY UPDATE polygon_coordinates = VALUES(polygon_coordinates)`,
      [req.params.id, JSON.stringify(polygon_coordinates)]
    );
    return success(res, {}, 'Geofence saved');
  } catch (err) { next(err); }
};

// ── Location Pricing ─────────────────────────────────────────────
const getLocationPricing = async (req, res, next) => {
  try {
    const locationId = parseInt(req.params.locationId);
    const [sizePricing, crustPricing, toppingPricing, crustSizePricing, toppingSizePricing] = await Promise.all([
      query(
        `SELECT plp.*, ps.size_name, ps.price as default_price, p.name as product_name
         FROM ProductLocationPricing plp
         JOIN ProductSizes ps ON ps.id = plp.product_size_id
         JOIN Products p ON p.id = ps.product_id
         WHERE plp.location_id = ?
         ORDER BY p.name, ps.size_name`, [locationId]
      ),
      query(
        `SELECT clp.*, ct.name as crust_name, ct.extra_price as default_extra_price
         FROM CrustLocationPricing clp
         JOIN CrustTypes ct ON ct.id = clp.crust_id
         WHERE clp.location_id = ?
         ORDER BY ct.name`, [locationId]
      ),
      query(
        `SELECT tlp.*, t.name as topping_name, t.price as default_price
         FROM ToppingLocationPricing tlp
         JOIN Toppings t ON t.id = tlp.topping_id
         WHERE tlp.location_id = ?
         ORDER BY t.name`, [locationId]
      ),
      query(`SELECT clsp.* FROM CrustLocationSizePricing clsp WHERE clsp.location_id = ?`, [locationId]),
      query(`SELECT tlsp.* FROM ToppingLocationSizePricing tlsp WHERE tlsp.location_id = ?`, [locationId]),
    ]);
    return success(res, {
      sizes: sizePricing,
      crusts: crustPricing,
      toppings: toppingPricing,
      crust_size_overrides: crustSizePricing,
      topping_size_overrides: toppingSizePricing
    });
  } catch (err) { next(err); }
};

const setLocationPricing = async (req, res, next) => {
  try {
    const { type, item_id, location_id, price, size_code } = req.body;
    if (!type || !item_id || !location_id || price == null) {
      return badRequest(res, 'type, item_id, location_id, and price are required');
    }
    if (type === 'size') {
      await query(
        `INSERT INTO ProductLocationPricing (product_size_id, location_id, price) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE price = VALUES(price)`,
        [item_id, location_id, price]
      );
    } else if (type === 'crust') {
      if (size_code) {
        await query(
          `INSERT INTO CrustLocationSizePricing (crust_id, location_id, size_code, extra_price) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE extra_price = VALUES(extra_price)`,
          [item_id, location_id, size_code, price]
        );
      } else {
        await query(
          `INSERT INTO CrustLocationPricing (crust_id, location_id, extra_price) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE extra_price = VALUES(extra_price)`,
          [item_id, location_id, price]
        );
      }
    } else if (type === 'topping') {
      if (size_code) {
        await query(
          `INSERT INTO ToppingLocationSizePricing (topping_id, location_id, size_code, price) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE price = VALUES(price)`,
          [item_id, location_id, size_code, price]
        );
      } else {
        await query(
          `INSERT INTO ToppingLocationPricing (topping_id, location_id, price) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE price = VALUES(price)`,
          [item_id, location_id, price]
        );
      }
    } else {
      return badRequest(res, 'type must be size, crust, or topping');
    }
    return success(res, {}, 'Location pricing saved');
  } catch (err) { next(err); }
};

const deleteLocationPricing = async (req, res, next) => {
  try {
    const { type, location_id, size_code } = req.query;
    const item_id = req.params.id;
    if (!type || !location_id) return badRequest(res, 'type and location_id query params required');
    
    if (type === 'size') {
      await query(`DELETE FROM ProductLocationPricing WHERE product_size_id = ? AND location_id = ?`, [item_id, location_id]);
    } else if (type === 'crust') {
      if (size_code) await query(`DELETE FROM CrustLocationSizePricing WHERE crust_id = ? AND location_id = ? AND size_code = ?`, [item_id, location_id, size_code]);
      else await query(`DELETE FROM CrustLocationPricing WHERE crust_id = ? AND location_id = ?`, [item_id, location_id]);
    } else if (type === 'topping') {
      if (size_code) await query(`DELETE FROM ToppingLocationSizePricing WHERE topping_id = ? AND location_id = ? AND size_code = ?`, [item_id, location_id, size_code]);
      else await query(`DELETE FROM ToppingLocationPricing WHERE topping_id = ? AND location_id = ?`, [item_id, location_id]);
    } else {
      return badRequest(res, 'type query param required (size, crust, or topping)');
    }
    return success(res, {}, 'Location pricing removed');
  } catch (err) { next(err); }
};

// ── Size-based Crust/Topping Pricing ─────────────────────────────
const getSizePricing = async (req, res, next) => {
  try {
    const lid = req.query.location_id ? parseInt(req.query.location_id) : null;
    let crustQuery, toppingQuery;

    if (lid) {
      crustQuery = `
        SELECT csp.*, clsp.extra_price as location_extra_price, ct.name as crust_name, ct.extra_price as default_extra_price
        FROM CrustSizePricing csp
        JOIN CrustTypes ct ON ct.id = csp.crust_id
        LEFT JOIN CrustLocationSizePricing clsp ON clsp.crust_id = csp.crust_id AND clsp.size_code = csp.size_code AND clsp.location_id = ?
        ORDER BY ct.name, csp.size_code`;
      toppingQuery = `
        SELECT tsp.*, tlsp.price as location_price, t.name as topping_name, t.price as default_price
        FROM ToppingSizePricing tsp
        JOIN Toppings t ON t.id = tsp.topping_id
        LEFT JOIN ToppingLocationSizePricing tlsp ON tlsp.topping_id = tsp.topping_id AND tlsp.size_code = tsp.size_code AND tlsp.location_id = ?
        ORDER BY t.name, tsp.size_code`;
    } else {
      crustQuery = `
        SELECT csp.*, ct.name as crust_name, ct.extra_price as default_extra_price
        FROM CrustSizePricing csp
        JOIN CrustTypes ct ON ct.id = csp.crust_id
        ORDER BY ct.name, csp.size_code`;
      toppingQuery = `
        SELECT tsp.*, t.name as topping_name, t.price as default_price
        FROM ToppingSizePricing tsp
        JOIN Toppings t ON t.id = tsp.topping_id
        ORDER BY t.name, tsp.size_code`;
    }

    const params = lid ? [lid] : [];
    const [crustPricing, toppingPricing] = await Promise.all([
      query(crustQuery, params),
      query(toppingQuery, params),
    ]);
    return success(res, { crusts: crustPricing, toppings: toppingPricing });
  } catch (err) { next(err); }
};

const setSizePricing = async (req, res, next) => {
  try {
    const { type, item_id, size_code, price, location_id } = req.body;
    if (!type || !item_id || !size_code || price == null) {
      return badRequest(res, 'type, item_id, size_code, and price are required');
    }

    if (location_id) {
      // Set location-specific price
      if (type === 'crust') {
        await query(
          `INSERT INTO CrustLocationSizePricing (crust_id, location_id, size_code, extra_price) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE extra_price = VALUES(extra_price)`,
          [item_id, location_id, size_code, price]
        );
      } else if (type === 'topping') {
        await query(
          `INSERT INTO ToppingLocationSizePricing (topping_id, location_id, size_code, price) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE price = VALUES(price)`,
          [item_id, location_id, size_code, price]
        );
      }
    } else {
      // Set global baseline price
      if (type === 'crust') {
        await query(
          `INSERT INTO CrustSizePricing (crust_id, size_code, extra_price) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE extra_price = VALUES(extra_price)`,
          [item_id, size_code, price]
        );
      } else if (type === 'topping') {
        await query(
          `INSERT INTO ToppingSizePricing (topping_id, size_code, price) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE price = VALUES(price)`,
          [item_id, size_code, price]
        );
      }
    }

    return success(res, {}, 'Size pricing saved');
  } catch (err) { next(err); }
};

const deleteSizePricing = async (req, res, next) => {
  try {
    const { type, location_id } = req.query;
    const item_id = req.params.itemId; // Using itemId from params for more specific delete if needed, but the user used id
    const size_code = req.query.size_code;

    if (location_id && size_code) {
      if (type === 'crust') await query(`DELETE FROM CrustLocationSizePricing WHERE crust_id = ? AND location_id = ? AND size_code = ?`, [req.params.id, location_id, size_code]);
      else if (type === 'topping') await query(`DELETE FROM ToppingLocationSizePricing WHERE topping_id = ? AND location_id = ? AND size_code = ?`, [req.params.id, location_id, size_code]);
    } else {
      if (type === 'crust') await query(`DELETE FROM CrustSizePricing WHERE id = ?`, [req.params.id]);
      else if (type === 'topping') await query(`DELETE FROM ToppingSizePricing WHERE id = ?`, [req.params.id]);
    }
    return success(res, {}, 'Size pricing removed');
  } catch (err) { next(err); }
};

module.exports = {
  adminLogin, getDashboard, getReports,
  adminGetOrders, adminGetOrderDetail, updateOrderStatus, updatePaymentStatus, adminPlaceOrder,
  acceptRejectOrder,
  adminGetUsers, blockUser,
  adminGetCategories, createCategory, updateCategory, deleteCategory, uploadCategoryImage,
  adminGetProducts, createProduct, updateProduct, deleteProduct, uploadProductImage,
  setProductLocationAvailability, getProductAvailabilityMatrix,
  adminGetProductSizes, createProductSize, updateProductSize, deleteProductSize,
  adminGetToppings, createTopping, updateTopping, deleteTopping,
  adminGetCrusts, createCrust, updateCrust, deleteCrust,
  adminGetLocations, createLocation, updateLocation,
  getDeliveryRiders, createDeliveryRider, updateDeliveryRider, deleteDeliveryRider, assignRiderToOrder,
  adminGetCoupons, createCoupon, updateCoupon,
  getAdminNotifications, markAdminNotifRead, markAllAdminNotifsRead,
  sendNotificationToUsers,
  adminGetReviews,
  adminGetBanners, createBanner, updateBanner, deleteBanner,
  getLocationGeofence, saveLocationGeofence,
  getLocationPricing, setLocationPricing, deleteLocationPricing,
  getSizePricing, setSizePricing, deleteSizePricing,
};
