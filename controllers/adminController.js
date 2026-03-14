const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/db');
const { success, created, badRequest, notFound, paginated, unauthorized } = require('../utils/response');

// ── Auth ───────────────────────────────────────────────────────────
const adminLogin = async (req, res, next) => {
  try {
    const { email, password, location_id } = req.body;
    const rows = await query(`SELECT * FROM Admins WHERE email = ? AND is_active = 1`, [email]);
    if (!rows.length) return unauthorized(res, 'Invalid credentials');
    const admin = rows[0];

    if (!await bcrypt.compare(password, admin.password_hash)) {
      return unauthorized(res, 'Invalid credentials');
    }

    // super_admin may specify a location to scope to; other roles use their assigned location
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

    // Fetch location name if scoped
    let locationName = null;
    if (resolvedLocationId) {
      const locRows = await query(`SELECT name FROM Locations WHERE id = ?`, [resolvedLocationId]);
      if (locRows.length) locationName = locRows[0].name;
    }
    const { password_hash, ...adminData } = admin;
    return success(res, {
      admin: { ...adminData, location_id: resolvedLocationId, location_name: locationName },
      token,
    });
  } catch (err) { next(err); }
};

// ── Dashboard ─────────────────────────────────────────────────────
const getDashboard = async (req, res, next) => {
  try {
    const lid = req.admin.location_id;
    const lf  = lid ? ` AND location_id = ${parseInt(lid)}` : '';
    const olF = lid ? ` AND o.location_id = ${parseInt(lid)}` : '';

    const [todayOrders, totalRevenue, newUsers, pendingOrders, popularProducts] = await Promise.all([
      query(`SELECT COUNT(*) as count, IFNULL(SUM(total_amount),0) as revenue
             FROM Orders WHERE DATE(created_at) = CURDATE() AND payment_status = 'paid'${lf}`),
      query(`SELECT IFNULL(SUM(total_amount),0) as total FROM Orders WHERE payment_status = 'paid'${lf}`),
      query(`SELECT COUNT(*) as count FROM Users WHERE DATE(created_at) = CURDATE()`),
      query(`SELECT COUNT(*) as count FROM Orders WHERE status IN ('pending','confirmed','preparing')${lf}`),
      query(`SELECT p.name, p.image_url, COUNT(oi.id) as order_count, SUM(oi.total_price) as revenue
             FROM OrderItems oi
             JOIN Products p ON oi.product_id = p.id
             JOIN Orders o ON oi.order_id = o.id AND o.payment_status = 'paid'${olF}
             GROUP BY p.id ORDER BY order_count DESC LIMIT 5`),
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
    const { period = 'daily' } = req.query;
    const lid = req.admin.location_id;
    const lf  = lid ? ` AND location_id = ${parseInt(lid)}` : '';

    let groupBy;
    if (period === 'daily') groupBy = `DATE(created_at)`;
    else if (period === 'weekly') groupBy = `YEAR(created_at), WEEK(created_at)`;
    else groupBy = `DATE_FORMAT(created_at,'%Y-%m')`;

    const rows = await query(`
      SELECT ${groupBy} as period,
             COUNT(*) as total_orders,
             IFNULL(SUM(total_amount),0) as revenue,
             COUNT(CASE WHEN status='delivered' THEN 1 END) as delivered,
             COUNT(CASE WHEN status='cancelled' THEN 1 END) as cancelled
      FROM Orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)${lf}
      GROUP BY ${groupBy}
      ORDER BY MIN(created_at) DESC
    `);
    return success(res, rows);
  } catch (err) { next(err); }
};

// ── Orders ────────────────────────────────────────────────────────
const adminGetOrders = async (req, res, next) => {
  try {
    const { status } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const lid = req.admin.location_id || (req.query.location_id ? parseInt(req.query.location_id) : null);

    let where = 'WHERE 1=1';
    const params = [];
    if (status)  { where += ' AND o.status = ?';      params.push(status); }
    if (lid)     { where += ' AND o.location_id = ?'; params.push(lid); }

    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Orders o ${where}`, params),
      query(`SELECT o.*, u.name as user_name, u.mobile as user_mobile, l.name as location_name
             FROM Orders o
             LEFT JOIN Users u ON o.user_id = u.id
             LEFT JOIN Locations l ON o.location_id = l.id
             ${where} ORDER BY o.created_at DESC
             LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const updateOrderStatus = async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const transitions = {
      pending: ['confirmed','cancelled'],
      confirmed: ['preparing','cancelled'],
      preparing: ['out_for_delivery','cancelled'],
      out_for_delivery: ['delivered'],
      delivered: ['refund_requested'],
      cancelled: [],
    };
    const [orderRow] = await query(`SELECT status FROM Orders WHERE id = ?`, [req.params.id]);
    if (!orderRow) return notFound(res, 'Order not found');

    if (!transitions[orderRow.status]?.includes(status)) {
      return badRequest(res, `Cannot transition from '${orderRow.status}' to '${status}'`);
    }
    await query(`UPDATE Orders SET status = ?, updated_at = NOW() WHERE id = ?`, [status, req.params.id]);
    await query(
      `INSERT INTO OrderStatusHistory (order_id, status, note, changed_by, changed_by_role)
       VALUES (?,?,?,?,'admin')`,
      [req.params.id, status, note || '', req.admin.id]
    );
    return success(res, {}, 'Order status updated');
  } catch (err) { next(err); }
};

// ── Users ─────────────────────────────────────────────────────────
const adminGetUsers = async (req, res, next) => {
  try {
    const { search, is_blocked } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];
    if (search) {
      where += ` AND (name LIKE ? OR email LIKE ? OR mobile LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (is_blocked !== undefined) { where += ` AND is_blocked = ?`; params.push(is_blocked === 'true' ? 1 : 0); }

    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Users ${where}`, params),
      query(`SELECT id, name, email, mobile, is_verified, is_active, is_blocked, created_at, last_login
             FROM Users ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
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

// ── Menu management ───────────────────────────────────────────────
const adminGetProducts = async (req, res, next) => {
  try {
    const { search, category_id, show_unavailable } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const lid    = req.admin.location_id;

    let where = 'WHERE 1=1';
    const params = [];

    // show_unavailable=true means show ALL (including globally unavailable) — for admin only
    if (show_unavailable !== 'true') { where += ` AND p.is_available = 1`; }

    if (category_id) { where += ` AND p.category_id = ?`; params.push(parseInt(category_id)); }
    if (search) {
      where += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    /* For location-scoped admins, also show the per-location availability status */
    let locSelect = '';
    let locJoin   = '';
    if (lid) {
      locJoin   = `LEFT JOIN ProductLocationAvailability pla ON pla.product_id = p.id AND pla.location_id = ${parseInt(lid)}`;
      locSelect = `, COALESCE(pla.is_available, 1) as location_available`;
    }

    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM Products p ${locJoin} ${where}`, params),
      query(`SELECT p.*, c.name as category_name${locSelect}
             FROM Products p
             LEFT JOIN Categories c ON p.category_id = c.id
             ${locJoin}
             ${where}
             ORDER BY p.category_id, p.sort_order, p.name
             LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const createProduct = async (req, res, next) => {
  try {
    const { category_id, name, description, base_price, is_veg, is_featured, sizes } = req.body;
    const r = await query(
      `INSERT INTO Products (category_id, name, description, base_price, is_veg, is_featured)
       VALUES (?,?,?,?,?,?)`,
      [category_id, name, description || null, parseFloat(base_price), is_veg ? 1 : 0, is_featured ? 1 : 0]
    );
    const productId = r.insertId;

    if (sizes?.length) {
      for (const sz of sizes) {
        await query(
          `INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`,
          [productId, sz.size_name, sz.size_code, parseFloat(sz.price)]
        );
      }
    } else {
      // Default single size
      await query(
        `INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`,
        [productId, 'Regular', 'REG', parseFloat(base_price)]
      );
    }
    return created(res, { product_id: productId }, 'Product created');
  } catch (err) { next(err); }
};

const updateProduct = async (req, res, next) => {
  try {
    const { name, description, base_price, is_veg, is_featured, is_available } = req.body;
    await query(
      `UPDATE Products SET
         name        = IFNULL(?, name),
         description = IFNULL(?, description),
         base_price  = IFNULL(?, base_price),
         is_veg      = IFNULL(?, is_veg),
         is_featured = IFNULL(?, is_featured),
         is_available= IFNULL(?, is_available),
         updated_at  = NOW()
       WHERE id = ?`,
      [
        name || null, description || null,
        base_price != null ? parseFloat(base_price) : null,
        is_veg      != null ? (is_veg ? 1 : 0)      : null,
        is_featured != null ? (is_featured ? 1 : 0)  : null,
        is_available!= null ? (is_available ? 1 : 0) : null,
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
    const productId = req.params.id;
    const [product] = await query(`SELECT id, image_url FROM Products WHERE id = ?`, [productId]);
    if (!product) return notFound(res, 'Product not found');

    if (product.image_url) {
      const oldPath = path.join(__dirname, '..', product.image_url.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
    }
    const imageUrl = `/uploads/products/${req.file.filename}`;
    await query(`UPDATE Products SET image_url = ?, updated_at = NOW() WHERE id = ?`, [imageUrl, productId]);

    const base = process.env.BASE_URL || 'http://13.232.73.121';
    return success(res, { image_url: `${base}${imageUrl}` }, 'Image uploaded');
  } catch (err) { next(err); }
};

// ── Per-location availability (the core feature) ──────────────────
const setProductLocationAvailability = async (req, res, next) => {
  try {
    const { is_available, location_id: bodyLocId } = req.body;
    const productId  = parseInt(req.params.id);
    const locationId = req.admin.location_id || (bodyLocId ? parseInt(bodyLocId) : null);

    if (!locationId) return badRequest(res, 'location_id is required');

    // Upsert
    await query(`
      INSERT INTO ProductLocationAvailability (product_id, location_id, is_available)
      VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE is_available = VALUES(is_available), updated_at = NOW()
    `, [productId, locationId, is_available ? 1 : 0]);

    return success(res, {}, `Product ${is_available ? 'enabled' : 'disabled'} at this location`);
  } catch (err) { next(err); }
};

// Get full availability matrix for a product (all locations)
const getProductAvailabilityMatrix = async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const locations = await query(`SELECT id, name FROM Locations WHERE is_active = 1 ORDER BY name`);
    const avails    = await query(
      `SELECT location_id, is_available FROM ProductLocationAvailability WHERE product_id = ?`,
      [productId]
    );
    const map = Object.fromEntries(avails.map(r => [r.location_id, r.is_available]));

    const matrix = locations.map(loc => ({
      location_id:   loc.id,
      location_name: loc.name,
      is_available:  map[loc.id] !== undefined ? map[loc.id] === 1 : true, // default = available
    }));
    return success(res, matrix);
  } catch (err) { next(err); }
};

// ── Coupons ───────────────────────────────────────────────────────
const createCoupon = async (req, res, next) => {
  try {
    const { code, description, discount_type, discount_value, min_order_value,
            max_discount, usage_limit, valid_from, valid_until } = req.body;
    await query(
      `INSERT INTO Coupons (code, description, discount_type, discount_value,
         min_order_value, max_discount, usage_limit, valid_from, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [code.toUpperCase(), description, discount_type, discount_value,
       min_order_value || 0, max_discount || null, usage_limit || null,
       new Date(valid_from), new Date(valid_until)]
    );
    return created(res, {}, 'Coupon created');
  } catch (err) { next(err); }
};

module.exports = {
  adminLogin, getDashboard, getReports,
  adminGetOrders, updateOrderStatus,
  adminGetUsers, blockUser,
  adminGetProducts, createProduct, updateProduct, deleteProduct,
  uploadProductImage, setProductLocationAvailability, getProductAvailabilityMatrix,
  createCoupon,
};
