const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/db');
const { success, created, badRequest, notFound, paginated, unauthorized } = require('../utils/response');

const adminLogin = async (req, res, next) => {
  try {
    const { email, password, location_id } = req.body;
    const result = await query(`SELECT * FROM Admins WHERE email = ? AND is_active = 1`, [email]);
    if (!result.length) return unauthorized(res, 'Invalid credentials');
    const admin = result[0];

    const isMatch = await bcrypt.compare(password, admin.password_hash);
    if (!isMatch) return unauthorized(res, 'Invalid credentials');

    let resolvedLocationId = admin.location_id;
    if (admin.role === 'super_admin' && location_id) {
      resolvedLocationId = parseInt(location_id);
    }

    await query(`UPDATE Admins SET last_login = NOW() WHERE id = ?`, [admin.id]);

    const token = jwt.sign(
      { id: admin.id, type: 'admin', role: admin.role, location_id: resolvedLocationId },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    const { password_hash, ...adminData } = admin;
    return success(res, { admin: { ...adminData, location_id: resolvedLocationId }, token });
  } catch (err) { next(err); }
};

const getDashboard = async (req, res, next) => {
  try {
    const locationId = req.admin.location_id;
    const locWhere = locationId ? ` AND o.location_id = ${parseInt(locationId)}` : '';
    const locWhereSimple = locationId ? ` AND location_id = ${parseInt(locationId)}` : '';

    const [todayOrders, totalRevenue, newUsers, pendingOrders, popularProducts] = await Promise.all([
      query(`SELECT COUNT(*) as count, IFNULL(SUM(total_amount),0) as revenue FROM Orders o WHERE DATE(created_at) = CURDATE() AND payment_status = 'paid'${locWhereSimple}`),
      query(`SELECT IFNULL(SUM(total_amount),0) as total FROM Orders o WHERE payment_status = 'paid'${locWhereSimple}`),
      query(`SELECT COUNT(*) as count FROM Users WHERE DATE(created_at) = CURDATE()`),
      query(`SELECT COUNT(*) as count FROM Orders o WHERE status IN ('pending','confirmed','preparing')${locWhereSimple}`),
      query(`SELECT p.name, p.image_url, COUNT(oi.id) as order_count, SUM(oi.total_price) as revenue
        FROM OrderItems oi JOIN Products p ON oi.product_id = p.id
        JOIN Orders o ON oi.order_id = o.id AND o.payment_status = 'paid'${locWhere}
        GROUP BY p.id, p.name, p.image_url ORDER BY order_count DESC LIMIT 5`),
    ]);

    return success(res, {
      today: { orders: todayOrders[0].count, revenue: todayOrders[0].revenue },
      total_revenue: totalRevenue[0].total,
      new_users_today: newUsers[0].count,
      pending_orders: pendingOrders[0].count,
      popular_products: popularProducts,
      location_id: locationId || null,
    });
  } catch (err) { next(err); }
};

const getReports = async (req, res, next) => {
  try {
    const { period = 'daily' } = req.query;
    const locationId = req.admin.location_id;
    const locFilter = locationId ? ` AND location_id = ${parseInt(locationId)}` : '';
    let groupBy;
    if (period === 'daily') groupBy = `DATE(created_at)`;
    else if (period === 'weekly') groupBy = `WEEK(created_at)`;
    else groupBy = `DATE_FORMAT(created_at, '%Y-%m')`;

    const result = await query(`
      SELECT ${groupBy} as period,
             COUNT(*) as total_orders,
             IFNULL(SUM(total_amount),0) as revenue,
             COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
             COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
      FROM Orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)${locFilter}
      GROUP BY ${groupBy}
      ORDER BY period DESC
    `);
    return success(res, result);
  } catch (err) { next(err); }
};

const adminGetOrders = async (req, res, next) => {
  try {
    const { status } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const adminLocationId = req.admin.location_id;
    const queryLocationId = req.query.location_id ? parseInt(req.query.location_id) : null;
    const effectiveLocationId = adminLocationId || queryLocationId;

    let whereClause = 'WHERE 1=1';
    const params = [];
    if (status) { whereClause += ' AND o.status = ?'; params.push(status); }
    if (effectiveLocationId) { whereClause += ' AND o.location_id = ?'; params.push(effectiveLocationId); }

    const countRes = await query(`SELECT COUNT(*) as total FROM Orders o ${whereClause}`, params);
    const result = await query(
      `SELECT o.*, u.name as user_name, u.mobile as user_mobile, l.name as location_name
       FROM Orders o
       LEFT JOIN Users u ON o.user_id = u.id
       LEFT JOIN Locations l ON o.location_id = l.id
       ${whereClause} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

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
    await query(`UPDATE Orders SET status = ?, updated_at = NOW() WHERE id = ?`, [status, req.params.id]);
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role) VALUES (?, ?, ?, ?, 'admin')`,
      [req.params.id, status, note || '', req.admin.id]
    );
    return success(res, {}, 'Order status updated');
  } catch (err) { next(err); }
};

const adminGetUsers = async (req, res, next) => {
  try {
    const { search, is_blocked } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
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
       FROM Users ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const blockUser = async (req, res, next) => {
  try {
    const { is_blocked } = req.body;
    await query(`UPDATE Users SET is_blocked = ? WHERE id = ?`, [is_blocked ? 1 : 0, req.params.id]);
    return success(res, {}, `User ${is_blocked ? 'blocked' : 'unblocked'} successfully`);
  } catch (err) { next(err); }
};

const createProduct = async (req, res, next) => {
  try {
    const { category_id, name, description, base_price, is_veg, is_featured, sizes } = req.body;
    const result = await query(
      `INSERT INTO Products (category_id, name, description, base_price, is_veg, is_featured) VALUES (?, ?, ?, ?, ?, ?)`,
      [category_id, name, description || null, parseFloat(base_price), is_veg ? 1 : 0, is_featured ? 1 : 0]
    );
    const productId = result.insertId;
    if (sizes && sizes.length) {
      for (const size of sizes) {
        await query(
          `INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?, ?, ?, ?)`,
          [productId, size.size_name, size.size_code, parseFloat(size.price)]
        );
      }
    }
    return created(res, { product_id: productId }, 'Product created');
  } catch (err) { next(err); }
};

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
        name || null, description || null,
        base_price ? parseFloat(base_price) : null,
        is_veg !== undefined ? (is_veg ? 1 : 0) : null,
        is_featured !== undefined ? (is_featured ? 1 : 0) : null,
        is_available !== undefined ? (is_available ? 1 : 0) : null,
        req.params.id,
      ]
    );
    return success(res, {}, 'Product updated');
  } catch (err) { next(err); }
};

const uploadProductImage = async (req, res, next) => {
  try {
    if (!req.file) return badRequest(res, 'No image file provided');
    const productId = req.params.id;
    const product = await query(`SELECT id, image_url FROM Products WHERE id = ?`, [productId]);
    if (!product.length) return notFound(res, 'Product not found');

    if (product[0].image_url) {
      const oldPath = path.join(__dirname, '..', product[0].image_url.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
    }

    const imageUrl = `/uploads/products/${req.file.filename}`;
    await query(`UPDATE Products SET image_url = ?, updated_at = NOW() WHERE id = ?`, [imageUrl, productId]);
    return success(res, { image_url: `${process.env.BASE_URL || 'http://13.232.73.121'}${imageUrl}` }, 'Image uploaded successfully');
  } catch (err) { next(err); }
};

const deleteProduct = async (req, res, next) => {
  try {
    await query(`UPDATE Products SET is_available = 0 WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Product removed from menu');
  } catch (err) { next(err); }
};

const setProductLocationAvailability = async (req, res, next) => {
  try {
    const { is_available } = req.body;
    const productId = parseInt(req.params.id);
    const locationId = req.admin.location_id || parseInt(req.body.location_id);
    if (!locationId) return badRequest(res, 'Location ID required');
    await query(`
      INSERT INTO ProductLocationAvailability (product_id, location_id, is_available)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE is_available = VALUES(is_available), updated_at = NOW()
    `, [productId, locationId, is_available ? 1 : 0]);
    return success(res, {}, `Product ${is_available ? 'enabled' : 'disabled'} for this location`);
  } catch (err) { next(err); }
};

const createCoupon = async (req, res, next) => {
  try {
    const { code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, valid_from, valid_until } = req.body;
    await query(
      `INSERT INTO Coupons (code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, valid_from, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code.toUpperCase(), description, discount_type, discount_value, min_order_value || 0, max_discount || null, usage_limit || null, new Date(valid_from), new Date(valid_until)]
    );
    return created(res, {}, 'Coupon created');
  } catch (err) { next(err); }
};

module.exports = {
  adminLogin, getDashboard, getReports,
  adminGetOrders, updateOrderStatus,
  adminGetUsers, blockUser,
  createProduct, updateProduct, deleteProduct, uploadProductImage,
  setProductLocationAvailability,
  createCoupon,
};
