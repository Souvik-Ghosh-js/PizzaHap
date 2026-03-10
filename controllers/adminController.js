const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { success, created, badRequest, notFound, paginated, unauthorized, conflict } = require('../utils/response');

// POST /admin/auth/login
const adminLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await query(
      `SELECT * FROM Admins WHERE email = ? AND is_active = 1`,
      [email]
    );
    if (!result.length) return unauthorized(res, 'Invalid credentials');
    const admin = result[0];

    const isMatch = await bcrypt.compare(password, admin.password_hash);
    if (!isMatch) return unauthorized(res, 'Invalid credentials');

    await query(`UPDATE Admins SET last_login = NOW() WHERE id = ?`, [admin.id]);

    const token = jwt.sign(
      { id: admin.id, type: 'admin', role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    const { password_hash, ...adminData } = admin;
    return success(res, { admin: adminData, token });
  } catch (err) { next(err); }
};

// GET /admin/dashboard
const getDashboard = async (req, res, next) => {
  try {
    const [todayOrders, totalRevenue, newUsers, pendingOrders, popularProducts] = await Promise.all([
      query(`SELECT COUNT(*) as count, IFNULL(SUM(total_amount),0) as revenue
             FROM Orders WHERE DATE(created_at) = CURDATE() AND payment_status = 'paid'`),
      query(`SELECT IFNULL(SUM(total_amount),0) as total FROM Orders WHERE payment_status = 'paid'`),
      query(`SELECT COUNT(*) as count FROM Users WHERE DATE(created_at) = CURDATE()`),
      query(`SELECT COUNT(*) as count FROM Orders WHERE status IN ('pending','confirmed','preparing')`),
      query(`
        SELECT p.name, p.image_url, COUNT(oi.id) as order_count, SUM(oi.total_price) as revenue
        FROM OrderItems oi JOIN Products p ON oi.product_id = p.id
        JOIN Orders o ON oi.order_id = o.id AND o.payment_status = 'paid'
        GROUP BY p.id, p.name, p.image_url ORDER BY order_count DESC LIMIT 5
      `),
    ]);

    return success(res, {
      today: {
        orders: todayOrders[0].count,
        revenue: todayOrders[0].revenue,
      },
      total_revenue: totalRevenue[0].total,
      new_users_today: newUsers[0].count,
      pending_orders: pendingOrders[0].count,
      popular_products: popularProducts,
    });
  } catch (err) { next(err); }
};

// GET /admin/dashboard/reports?period=daily|weekly|monthly
const getReports = async (req, res, next) => {
  try {
    const { period = 'daily' } = req.query;
    let groupBy;
    if (period === 'daily') { groupBy = `DATE(created_at)`; }
    else if (period === 'weekly') { groupBy = `WEEK(created_at)`; }
    else { groupBy = `DATE_FORMAT(created_at, '%Y-%m')`; }

    const result = await query(`
      SELECT ${groupBy} as period,
             COUNT(*) as total_orders,
             IFNULL(SUM(total_amount),0) as revenue,
             COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
             COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
      FROM Orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY ${groupBy}
      ORDER BY period DESC
    `);
    return success(res, result);
  } catch (err) { next(err); }
};

// GET /admin/orders
const adminGetOrders = async (req, res, next) => {
  try {
    const { status, location_id, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = 'WHERE 1=1';
    const params = [];
    if (status) { whereClause += ' AND o.status = ?'; params.push(status); }
    if (location_id) { whereClause += ' AND o.location_id = ?'; params.push(parseInt(location_id)); }

    const countRes = await query(`SELECT COUNT(*) as total FROM Orders o ${whereClause}`, params);
    const result = await query(
      `SELECT o.*, u.name as user_name, u.mobile as user_mobile, l.name as location_name
       FROM Orders o
       LEFT JOIN Users u ON o.user_id = u.id
       LEFT JOIN Locations l ON o.location_id = l.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

// PUT /admin/orders/:id/status
const updateOrderStatus = async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const validTransitions = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['preparing', 'cancelled'],
      preparing: ['out_for_delivery', 'cancelled'],
      out_for_delivery: ['delivered'],
      delivered: ['refund_requested'],
      cancelled: [],
    };

    const orderResult = await query(`SELECT status FROM Orders WHERE id = ?`, [req.params.id]);
    if (!orderResult.length) return notFound(res, 'Order not found');
    const current = orderResult[0].status;

    if (!validTransitions[current]?.includes(status)) {
      return badRequest(res, `Cannot transition from '${current}' to '${status}'`);
    }

    await query(
      `UPDATE Orders SET status = ?, updated_at = NOW() WHERE id = ?`,
      [status, req.params.id]
    );
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role)
       VALUES (?, ?, ?, ?, 'admin')`,
      [req.params.id, status, note || '', req.admin.id]
    );
    return success(res, {}, 'Order status updated');
  } catch (err) { next(err); }
};

// GET /admin/users
const adminGetUsers = async (req, res, next) => {
  try {
    const { search, is_blocked, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = 'WHERE 1=1';
    const params = [];
    if (search) {
      whereClause += ` AND (name LIKE ? OR email LIKE ? OR mobile LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (is_blocked !== undefined) {
      whereClause += ` AND is_blocked = ?`;
      params.push(is_blocked === 'true' ? 1 : 0);
    }
    const countRes = await query(`SELECT COUNT(*) as total FROM Users ${whereClause}`, params);
    const result = await query(
      `SELECT id, name, email, mobile, is_verified, is_active, is_blocked, created_at, last_login
       FROM Users ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

// PUT /admin/users/:id/block
const blockUser = async (req, res, next) => {
  try {
    const { is_blocked } = req.body;
    await query(
      `UPDATE Users SET is_blocked = ? WHERE id = ?`,
      [is_blocked ? 1 : 0, req.params.id]
    );
    return success(res, {}, `User ${is_blocked ? 'blocked' : 'unblocked'} successfully`);
  } catch (err) { next(err); }
};

// POST /admin/menu/products
const createProduct = async (req, res, next) => {
  try {
    const { category_id, name, description, base_price, is_veg, is_featured, sizes } = req.body;
    const result = await query(
      `INSERT INTO Products (category_id, name, description, base_price, is_veg, is_featured)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [category_id, name, description || null, base_price, is_veg ? 1 : 0, is_featured ? 1 : 0]
    );
    const productId = result.insertId;

    if (sizes && sizes.length) {
      for (const size of sizes) {
        await query(
          `INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?, ?, ?, ?)`,
          [productId, size.size_name, size.size_code, size.price]
        );
      }
    }

    return created(res, { product_id: productId }, 'Product created');
  } catch (err) { next(err); }
};

// PUT /admin/menu/products/:id
const updateProduct = async (req, res, next) => {
  try {
    const { name, description, base_price, is_veg, is_featured, is_available } = req.body;
    await query(
      `UPDATE Products SET
         name = IFNULL(?, name),
         description = IFNULL(?, description),
         base_price = IFNULL(?, base_price),
         is_veg = IFNULL(?, is_veg),
         is_featured = IFNULL(?, is_featured),
         is_available = IFNULL(?, is_available),
         updated_at = NOW()
       WHERE id = ?`,
      [
        name || null,
        description || null,
        base_price || null,
        is_veg !== undefined ? (is_veg ? 1 : 0) : null,
        is_featured !== undefined ? (is_featured ? 1 : 0) : null,
        is_available !== undefined ? (is_available ? 1 : 0) : null,
        req.params.id,
      ]
    );
    return success(res, {}, 'Product updated');
  } catch (err) { next(err); }
};

// DELETE /admin/menu/products/:id
const deleteProduct = async (req, res, next) => {
  try {
    await query(`UPDATE Products SET is_available = 0 WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Product removed from menu');
  } catch (err) { next(err); }
};

// POST /admin/coupons
const createCoupon = async (req, res, next) => {
  try {
    const { code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, valid_from, valid_until } = req.body;
    await query(
      `INSERT INTO Coupons (code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code.toUpperCase(), description, discount_type, discount_value,
        min_order_value || 0, max_discount || null, usage_limit || null,
        new Date(valid_from), new Date(valid_until),
      ]
    );
    return created(res, {}, 'Coupon created');
  } catch (err) { next(err); }
};

module.exports = {
  adminLogin, getDashboard, getReports,
  adminGetOrders, updateOrderStatus,
  adminGetUsers, blockUser,
  createProduct, updateProduct, deleteProduct,
  createCoupon,
};
