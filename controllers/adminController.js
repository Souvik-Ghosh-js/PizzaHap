const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { query, transaction } = require('../config/db');
const { success, created, badRequest, notFound, paginated, unauthorized, conflict } = require('../utils/response');
const { notifyUser, notifyAdmins, creditCoins, revertCoins } = require('../services/notificationService');

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
    const token = jwt.sign({ id: admin.id, type: 'admin', role: admin.role, location_id: resolvedLocationId }, process.env.JWT_SECRET, { expiresIn: '12h' });
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
    const lid = req.admin.location_id;
    const lf  = lid ? ` AND location_id = ${parseInt(lid)}` : '';
    const olF = lid ? ` AND o.location_id = ${parseInt(lid)}` : '';
    const [todayOrders, totalRevenue, newUsers, pendingOrders, popularProducts] = await Promise.all([
      query(`SELECT COUNT(*) as count, IFNULL(SUM(total_amount),0) as revenue FROM Orders WHERE DATE(created_at) = CURDATE() AND payment_status = 'paid'${lf}`),
      query(`SELECT IFNULL(SUM(total_amount),0) as total FROM Orders WHERE payment_status = 'paid'${lf}`),
      query(`SELECT COUNT(*) as count FROM Users WHERE DATE(created_at) = CURDATE()`),
      query(`SELECT COUNT(*) as count FROM Orders WHERE status IN ('pending','confirmed','preparing')${lf}`),
      query(`SELECT p.name, p.image_url, COUNT(oi.id) as order_count, SUM(oi.total_price) as revenue FROM OrderItems oi JOIN Products p ON oi.product_id = p.id JOIN Orders o ON oi.order_id = o.id AND o.payment_status = 'paid'${olF} GROUP BY p.id ORDER BY order_count DESC LIMIT 5`),
    ]);
    return success(res, { today: { orders: todayOrders[0].count, revenue: todayOrders[0].revenue }, total_revenue: totalRevenue[0].total, new_users_today: newUsers[0].count, pending_orders: pendingOrders[0].count, popular_products: popularProducts, location_id: lid || null });
  } catch (err) { next(err); }
};

const getReports = async (req, res, next) => {
  try {
    const { period = 'daily' } = req.query;
    const lid = req.admin.location_id;
    const lf  = lid ? ` AND location_id = ${parseInt(lid)}` : '';
    let groupBy;
    if (period === 'daily') groupBy = `DATE(created_at)`;
    else if (period === 'weekly') groupBy = `YEAR(created_at), WEEK(created_at)`;
    else groupBy = `DATE_FORMAT(created_at,'%Y-%m')`;
    const rows = await query(`SELECT ${groupBy} as period, COUNT(*) as total_orders, IFNULL(SUM(total_amount),0) as revenue, COUNT(CASE WHEN status='delivered' THEN 1 END) as delivered, COUNT(CASE WHEN status='cancelled' THEN 1 END) as cancelled FROM Orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)${lf} GROUP BY ${groupBy} ORDER BY MIN(created_at) DESC`);
    return success(res, rows);
  } catch (err) { next(err); }
};

// ── Orders ────────────────────────────────────────────────────────
const adminGetOrders = async (req, res, next) => {
  try {
    const { status, payment_status } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const lid = req.admin.location_id || (req.query.location_id ? parseInt(req.query.location_id) : null);
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND o.status = ?'; params.push(status); }
    if (payment_status) { where += ' AND o.payment_status = ?'; params.push(payment_status); }
    if (lid) { where += ' AND o.location_id = ?'; params.push(lid); }
    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Orders o ${where}`, params),
      query(`SELECT o.*, u.name as user_name, u.mobile as user_mobile, l.name as location_name FROM Orders o LEFT JOIN Users u ON o.user_id = u.id LEFT JOIN Locations l ON o.location_id = l.id ${where} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const adminGetOrderDetail = async (req, res, next) => {
  try {
    const lid = req.admin.location_id;
    let where = `WHERE o.id = ?`;
    const params = [req.params.id];
    if (lid) { where += ` AND o.location_id = ?`; params.push(lid); }
    const orderResult = await query(
      `SELECT o.*, u.name as user_name, u.mobile as user_mobile, u.email as user_email, l.name as location_name, l.address as location_address FROM Orders o LEFT JOIN Users u ON o.user_id = u.id LEFT JOIN Locations l ON o.location_id = l.id ${where}`,
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
    };
    const [orderRow] = await query(`SELECT * FROM Orders WHERE id = ?`, [req.params.id]);
    if (!orderRow) return notFound(res, 'Order not found');
    if (!transitions[orderRow.status]?.includes(status)) {
      return badRequest(res, `Cannot transition from '${orderRow.status}' to '${status}'`);
    }
    await query(`UPDATE Orders SET status = ?, updated_at = NOW() WHERE id = ?`, [status, req.params.id]);
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,?,?,?,'admin')`,
      [req.params.id, status, note || '', req.admin.id]
    );

    // Notify user of status change
    const statusMessages = {
      confirmed:        'Your order has been confirmed and will be prepared shortly.',
      preparing:        'Your order is being prepared!',
      out_for_delivery: 'Your order is on the way!',
      delivered:        'Your order has been delivered. Enjoy!',
      cancelled:        'Your order has been cancelled.',
    };
    if (orderRow.user_id && statusMessages[status]) {
      await notifyUser(orderRow.user_id, `Order ${status.replace(/_/g,' ')}`, statusMessages[status], 'order', { order_id: orderRow.id, order_number: orderRow.order_number, status });
    }

    // Credit coins on delivery: 1 coin per Rs.10 spent
    if (status === 'delivered' && orderRow.user_id) {
      const coinsEarned = Math.floor(orderRow.total_amount / 10);
      if (coinsEarned > 0) await creditCoins(orderRow.user_id, orderRow.id, coinsEarned);
    }

    return success(res, {}, 'Order status updated');
  } catch (err) { next(err); }
};

// ── Payment status (for COD cash marking, or manual override) ─────
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

// ── In-house / admin billing: place order on behalf of user ───────
const adminPlaceOrder = async (req, res, next) => {
  try {
    const {
      user_id, items, location_id, delivery_type = 'pickup',
      delivery_address, special_instructions,
      payment_method = 'cash_on_delivery',
    } = req.body;

    // Resolve location — admin's own location takes precedence
    const resolvedLocationId = req.admin.location_id || location_id;
    if (!resolvedLocationId) return badRequest(res, 'location_id is required');

    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const productResult = await query(
        `SELECT p.*, ps.price as size_price, ps.size_name, ct.extra_price as crust_extra, ct.name as crust_name
         FROM Products p JOIN ProductSizes ps ON ps.id = ? AND ps.product_id = p.id
         LEFT JOIN CrustTypes ct ON ct.id = ? WHERE p.id = ? AND p.is_available = 1`,
        [item.size_id, item.crust_id || null, item.product_id]
      );
      if (!productResult.length) return badRequest(res, `Product not available`);
      const product = productResult[0];
      let itemPrice = product.size_price + (product.crust_extra || 0);
      const itemToppings = [];
      if (item.toppings?.length) {
        for (const tid of item.toppings) {
          const tr = await query(`SELECT * FROM Toppings WHERE id = ? AND is_available = 1`, [tid]);
          if (tr.length) { itemPrice += tr[0].price; itemToppings.push(tr[0]); }
        }
      }
      const total_price = parseFloat((itemPrice * (item.quantity || 1)).toFixed(2));
      subtotal += total_price;
      orderItems.push({ ...item, product, unit_price: itemPrice, total_price, toppings: itemToppings });
    }

    const delivery_fee = delivery_type === 'pickup' ? 0 : (subtotal < 300 ? 40 : 0);
    const tax_amount = parseFloat((subtotal + delivery_fee) * 0.05).toFixed(2);
    const total_amount = parseFloat(((subtotal + delivery_fee) * 1.05).toFixed(2));
    const order_number = generateOrderNumber();

    const orderId = await transaction(async (conn) => {
      const [orderResult] = await conn.execute(
        `INSERT INTO Orders (order_number, user_id, location_id, delivery_type, delivery_address, subtotal, discount_amount, delivery_fee, tax_amount, total_amount, special_instructions, payment_status, payment_method) VALUES (?,?,?,?,?,?,0,?,?,?,?,'pending',?)`,
        [order_number, user_id || null, resolvedLocationId, delivery_type, delivery_address || null, subtotal, delivery_fee, tax_amount, total_amount, special_instructions || null, payment_method]
      );
      const newOrderId = orderResult.insertId;
      for (const item of orderItems) {
        const [itemResult] = await conn.execute(
          `INSERT INTO OrderItems (order_id, product_id, product_name, size_id, size_name, crust_id, crust_name, quantity, unit_price, total_price) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [newOrderId, item.product_id, item.product.name, item.size_id, item.product.size_name, item.crust_id || null, item.product.crust_name || null, item.quantity || 1, parseFloat(item.unit_price).toFixed(2), item.total_price]
        );
        for (const topping of item.toppings) {
          await conn.execute(`INSERT INTO OrderItemToppings (order_item_id, topping_id, topping_name, price) VALUES (?,?,?,?)`, [itemResult.insertId, topping.id, topping.name, topping.price]);
        }
      }
      await conn.execute(
        `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?,'pending','In-house order created by admin',?,'admin')`,
        [newOrderId, req.admin.id]
      );
      return newOrderId;
    });

    if (user_id) {
      await notifyUser(user_id, 'Order Created', `An order ${order_number} has been created for you. Total: Rs.${total_amount}`, 'order', { order_id: orderId, order_number });
    }

    return created(res, { order_id: orderId, order_number, total_amount, payment_method }, 'In-house order created');
  } catch (err) { next(err); }
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
      query(`SELECT u.id, u.name, u.email, u.mobile, u.is_verified, u.is_active, u.is_blocked, u.created_at, u.last_login, u.address_house, u.address_town, u.address_state, u.address_pincode, COALESCE(uc.balance,0) as coin_balance FROM Users u LEFT JOIN UserCoins uc ON uc.user_id = u.id ${where} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
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

// ── Menu ──────────────────────────────────────────────────────────
const adminGetProducts = async (req, res, next) => {
  try {
    const { search, category_id, show_unavailable } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const lid = req.admin.location_id;
    let where = 'WHERE 1=1';
    const params = [];
    if (show_unavailable !== 'true') { where += ` AND p.is_available = 1`; }
    if (category_id) { where += ` AND p.category_id = ?`; params.push(parseInt(category_id)); }
    if (search) { where += ` AND (p.name LIKE ? OR p.description LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
    let locSelect = '', locJoin = '';
    if (lid) {
      locJoin = `LEFT JOIN ProductLocationAvailability pla ON pla.product_id = p.id AND pla.location_id = ${parseInt(lid)}`;
      locSelect = `, COALESCE(pla.is_available, 1) as location_available`;
    }
    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Products p ${locJoin} ${where}`, params),
      query(`SELECT p.*, c.name as category_name${locSelect} FROM Products p LEFT JOIN Categories c ON p.category_id = c.id ${locJoin} ${where} ORDER BY p.category_id, p.sort_order, p.name LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const createProduct = async (req, res, next) => {
  try {
    const { category_id, name, description, base_price, is_veg, is_featured, sizes } = req.body;
    const r = await query(`INSERT INTO Products (category_id, name, description, base_price, is_veg, is_featured) VALUES (?,?,?,?,?,?)`, [category_id, name, description || null, parseFloat(base_price), is_veg ? 1 : 0, is_featured ? 1 : 0]);
    const productId = r.insertId;
    if (sizes?.length) {
      for (const sz of sizes) await query(`INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`, [productId, sz.size_name, sz.size_code, parseFloat(sz.price)]);
    } else {
      await query(`INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`, [productId, 'Regular', 'REG', parseFloat(base_price)]);
    }
    return created(res, { product_id: productId }, 'Product created');
  } catch (err) { next(err); }
};

const updateProduct = async (req, res, next) => {
  try {
    const { name, description, base_price, is_veg, is_featured, is_available } = req.body;
    await query(`UPDATE Products SET name = IFNULL(?,name), description = IFNULL(?,description), base_price = IFNULL(?,base_price), is_veg = IFNULL(?,is_veg), is_featured = IFNULL(?,is_featured), is_available = IFNULL(?,is_available), updated_at = NOW() WHERE id = ?`,
      [name || null, description || null, base_price != null ? parseFloat(base_price) : null, is_veg != null ? (is_veg ? 1 : 0) : null, is_featured != null ? (is_featured ? 1 : 0) : null, is_available != null ? (is_available ? 1 : 0) : null, req.params.id]);
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
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
    }
    const imageUrl = `/uploads/products/${req.file.filename}`;
    await query(`UPDATE Products SET image_url = ?, updated_at = NOW() WHERE id = ?`, [imageUrl, req.params.id]);
    const base = process.env.BASE_URL || 'http://13.232.73.121';
    return success(res, { image_url: `${base}${imageUrl}` }, 'Image uploaded');
  } catch (err) { next(err); }
};

const setProductLocationAvailability = async (req, res, next) => {
  try {
    const { is_available, location_id: bodyLocId } = req.body;
    const productId = parseInt(req.params.id);
    const locationId = req.admin.location_id || (bodyLocId ? parseInt(bodyLocId) : null);
    if (!locationId) return badRequest(res, 'location_id is required');
    await query(`INSERT INTO ProductLocationAvailability (product_id, location_id, is_available) VALUES (?,?,?) ON DUPLICATE KEY UPDATE is_available = VALUES(is_available), updated_at = NOW()`, [productId, locationId, is_available ? 1 : 0]);
    return success(res, {}, `Product ${is_available ? 'enabled' : 'disabled'} at this location`);
  } catch (err) { next(err); }
};

const getProductAvailabilityMatrix = async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const locations = await query(`SELECT id, name FROM Locations WHERE is_active = 1 ORDER BY name`);
    const avails = await query(`SELECT location_id, is_available FROM ProductLocationAvailability WHERE product_id = ?`, [productId]);
    const map = Object.fromEntries(avails.map(r => [r.location_id, r.is_available]));
    const matrix = locations.map(loc => ({ location_id: loc.id, location_name: loc.name, is_available: map[loc.id] !== undefined ? map[loc.id] === 1 : true }));
    return success(res, matrix);
  } catch (err) { next(err); }
};

// ── Toppings CRUD ─────────────────────────────────────────────────
const adminGetToppings = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM Toppings ORDER BY sort_order, name`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createTopping = async (req, res, next) => {
  try {
    const { name, price, is_veg = 1, sort_order = 0 } = req.body;
    const r = await query(`INSERT INTO Toppings (name, price, is_veg, sort_order) VALUES (?,?,?,?)`, [name, parseFloat(price), is_veg ? 1 : 0, sort_order]);
    return created(res, { topping_id: r.insertId }, 'Topping created');
  } catch (err) { next(err); }
};

const updateTopping = async (req, res, next) => {
  try {
    const { name, price, is_veg, is_available, sort_order } = req.body;
    await query(`UPDATE Toppings SET name = IFNULL(?,name), price = IFNULL(?,price), is_veg = IFNULL(?,is_veg), is_available = IFNULL(?,is_available), sort_order = IFNULL(?,sort_order) WHERE id = ?`,
      [name || null, price != null ? parseFloat(price) : null, is_veg != null ? (is_veg ? 1 : 0) : null, is_available != null ? (is_available ? 1 : 0) : null, sort_order != null ? sort_order : null, req.params.id]);
    return success(res, {}, 'Topping updated');
  } catch (err) { next(err); }
};

const deleteTopping = async (req, res, next) => {
  try {
    await query(`UPDATE Toppings SET is_available = 0 WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Topping disabled');
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
    const r = await query(`INSERT INTO Locations (name, address, city, latitude, longitude, phone, email, opening_time, closing_time) VALUES (?,?,?,?,?,?,?,?,?)`,
      [name, address, city, latitude, longitude, phone || null, email || null, opening_time || '10:00:00', closing_time || '23:00:00']);
    return created(res, { location_id: r.insertId }, 'Location created');
  } catch (err) { next(err); }
};

const updateLocation = async (req, res, next) => {
  try {
    const { name, address, city, latitude, longitude, phone, email, is_active, opening_time, closing_time } = req.body;
    await query(`UPDATE Locations SET name = IFNULL(?,name), address = IFNULL(?,address), city = IFNULL(?,city), latitude = IFNULL(?,latitude), longitude = IFNULL(?,longitude), phone = IFNULL(?,phone), email = IFNULL(?,email), is_active = IFNULL(?,is_active), opening_time = IFNULL(?,opening_time), closing_time = IFNULL(?,closing_time) WHERE id = ?`,
      [name||null, address||null, city||null, latitude||null, longitude||null, phone||null, email||null, is_active!=null?(is_active?1:0):null, opening_time||null, closing_time||null, req.params.id]);
    return success(res, {}, 'Location updated');
  } catch (err) { next(err); }
};

// ── Coupons ───────────────────────────────────────────────────────
const adminGetCoupons = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM Coupons ORDER BY created_at DESC`);
    return success(res, rows);
  } catch (err) { next(err); }
};

const createCoupon = async (req, res, next) => {
  try {
    const { code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, per_user_limit, valid_from, valid_until } = req.body;
    await query(`INSERT INTO Coupons (code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, per_user_limit, valid_from, valid_until) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [code.toUpperCase(), description, discount_type, discount_value, min_order_value || 0, max_discount || null, usage_limit || null, per_user_limit || 1, new Date(valid_from), new Date(valid_until)]);
    return created(res, {}, 'Coupon created');
  } catch (err) { next(err); }
};

const updateCoupon = async (req, res, next) => {
  try {
    const { is_active, description, discount_value, min_order_value, max_discount, usage_limit, valid_until } = req.body;
    await query(`UPDATE Coupons SET is_active = IFNULL(?,is_active), description = IFNULL(?,description), discount_value = IFNULL(?,discount_value), min_order_value = IFNULL(?,min_order_value), max_discount = IFNULL(?,max_discount), usage_limit = IFNULL(?,usage_limit), valid_until = IFNULL(?,valid_until) WHERE id = ?`,
      [is_active!=null?(is_active?1:0):null, description||null, discount_value||null, min_order_value||null, max_discount||null, usage_limit||null, valid_until?new Date(valid_until):null, req.params.id]);
    return success(res, {}, 'Coupon updated');
  } catch (err) { next(err); }
};

// ── Admin Notifications ───────────────────────────────────────────
const getAdminNotifications = async (req, res, next) => {
  try {
    const lid = req.admin.location_id;
    let where = `WHERE (an.admin_id = ?`;
    const params = [req.admin.id];
    if (lid) { where += ` OR an.location_id = ?`; params.push(lid); }
    where += `)`;
    const rows = await query(
      `SELECT an.* FROM AdminNotifications an ${where} ORDER BY an.created_at DESC LIMIT 100`,
      params
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

// ── Create notification broadcast ────────────────────────────────
const sendNotificationToUsers = async (req, res, next) => {
  try {
    const { title, message, type = 'promo', user_ids } = req.body;
    // If user_ids provided, send to those; otherwise broadcast to all active users
    let users;
    if (user_ids?.length) {
      users = await query(`SELECT id FROM Users WHERE id IN (${user_ids.map(() => '?').join(',')}) AND is_active = 1`, user_ids);
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

module.exports = {
  adminLogin, getDashboard, getReports,
  adminGetOrders, adminGetOrderDetail, updateOrderStatus, updatePaymentStatus, adminPlaceOrder,
  adminGetUsers, blockUser,
  adminGetProducts, createProduct, updateProduct, deleteProduct, uploadProductImage,
  setProductLocationAvailability, getProductAvailabilityMatrix,
  adminGetToppings, createTopping, updateTopping, deleteTopping,
  adminGetLocations, createLocation, updateLocation,
  adminGetCoupons, createCoupon, updateCoupon,
  getAdminNotifications, markAdminNotifRead, markAllAdminNotifsRead,
  sendNotificationToUsers,
};
