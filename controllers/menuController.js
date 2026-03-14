const path = require('path');
const fs = require('fs');
const { query } = require('../config/db');
const { success, notFound, paginated, badRequest } = require('../utils/response');

const getCategories = async (req, res, next) => {
  try {
    const result = await query(`SELECT * FROM Categories WHERE is_active = 1 ORDER BY sort_order`);
    return success(res, result);
  } catch (err) { next(err); }
};

const getProducts = async (req, res, next) => {
  try {
    const { category_id, is_veg, search, location_id } = req.query;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // Products can be filtered by location availability
    let whereClause = `WHERE p.is_available = 1`;
    const params = [];

    if (location_id) {
      // If a location is set, also exclude products marked unavailable at that location
      whereClause += ` AND (
        NOT EXISTS (
          SELECT 1 FROM ProductLocationOverrides plo
          WHERE plo.product_id = p.id AND plo.location_id = ? AND plo.is_available = 0
        )
      )`;
      params.push(parseInt(location_id));
    }
    if (category_id) { whereClause += ` AND p.category_id = ?`; params.push(parseInt(category_id)); }
    if (is_veg !== undefined) { whereClause += ` AND p.is_veg = ?`; params.push(is_veg === 'true' ? 1 : 0); }
    if (search) {
      whereClause += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const countResult = await query(`SELECT COUNT(*) as total FROM Products p ${whereClause}`, params);
    const result = await query(
      `SELECT p.*, c.name as category_name
       FROM Products p LEFT JOIN Categories c ON p.category_id = c.id
       ${whereClause} ORDER BY p.sort_order, p.name LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return paginated(res, result, countResult[0].total, page, limit);
  } catch (err) { next(err); }
};

const getProductById = async (req, res, next) => {
  try {
    const productResult = await query(
      `SELECT p.*, c.name as category_name FROM Products p
       LEFT JOIN Categories c ON p.category_id = c.id
       WHERE p.id = ? AND p.is_available = 1`,
      [req.params.id]
    );
    if (!productResult.length) return notFound(res, 'Product not found');
    const product = productResult[0];

    const [sizes, crusts, toppings, ratings] = await Promise.all([
      query(`SELECT * FROM ProductSizes WHERE product_id = ? AND is_available = 1`, [product.id]),
      query(`SELECT * FROM CrustTypes WHERE is_available = 1 ORDER BY sort_order`),
      query(`SELECT * FROM Toppings WHERE is_available = 1 ORDER BY sort_order`),
      query(
        `SELECT r.*, u.name as user_name FROM Ratings r LEFT JOIN Users u ON r.user_id = u.id
         WHERE r.product_id = ? AND r.is_approved = 1 ORDER BY r.created_at DESC`,
        [product.id]
      ),
    ]);

    const avgRating = ratings.length
      ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1) : null;

    return success(res, {
      ...product, sizes, crusts, toppings,
      avg_rating: avgRating, review_count: ratings.length, reviews: ratings.slice(0, 5),
    });
  } catch (err) { next(err); }
};

const getFeaturedProducts = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    let whereClause = `WHERE p.is_featured = 1 AND p.is_available = 1`;
    const params = [];
    if (location_id) {
      whereClause += ` AND NOT EXISTS (
        SELECT 1 FROM ProductLocationOverrides plo
        WHERE plo.product_id = p.id AND plo.location_id = ? AND plo.is_available = 0)`;
      params.push(parseInt(location_id));
    }
    const result = await query(
      `SELECT p.*, c.name as category_name FROM Products p
       LEFT JOIN Categories c ON p.category_id = c.id
       ${whereClause} ORDER BY p.sort_order LIMIT 10`,
      params
    );
    return success(res, result);
  } catch (err) { next(err); }
};

const getToppings = async (req, res, next) => {
  try {
    const { is_veg } = req.query;
    let whereClause = 'WHERE is_available = 1';
    const params = [];
    if (is_veg !== undefined) { whereClause += ' AND is_veg = ?'; params.push(is_veg === 'true' ? 1 : 0); }
    const result = await query(`SELECT * FROM Toppings ${whereClause} ORDER BY sort_order`, params);
    return success(res, result);
  } catch (err) { next(err); }
};

const getCrusts = async (req, res, next) => {
  try {
    const result = await query(`SELECT * FROM CrustTypes WHERE is_available = 1 ORDER BY sort_order`);
    return success(res, result);
  } catch (err) { next(err); }
};

// ─── ADMIN: Upload product image ────────────────────────────────────
const uploadProductImage = async (req, res, next) => {
  try {
    if (!req.file) return badRequest(res, 'No image file uploaded');
    const productId = req.params.id;
    const imageUrl = `/uploads/products/${req.file.filename}`;

    await query(`UPDATE Products SET image_url = ?, updated_at = NOW() WHERE id = ?`, [imageUrl, productId]);
    return success(res, { image_url: `${process.env.APP_URL}${imageUrl}` }, 'Product image updated');
  } catch (err) { next(err); }
};

// ─── ADMIN: Toggle product availability at a location ───────────────
const setProductLocationAvailability = async (req, res, next) => {
  try {
    const { product_id, location_id, is_available } = req.body;
    // Upsert into ProductLocationOverrides
    await query(
      `INSERT INTO ProductLocationOverrides (product_id, location_id, is_available)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE is_available = VALUES(is_available)`,
      [product_id, location_id, is_available ? 1 : 0]
    );
    return success(res, {}, `Product ${is_available ? 'enabled' : 'disabled'} at this location`);
  } catch (err) { next(err); }
};

// ─── ADMIN: Get product location overrides ──────────────────────────
const getProductLocationOverrides = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    const params = [];
    let where = '';
    if (location_id) { where = 'WHERE plo.location_id = ?'; params.push(parseInt(location_id)); }
    const result = await query(
      `SELECT plo.*, p.name as product_name, l.name as location_name
       FROM ProductLocationOverrides plo
       JOIN Products p ON plo.product_id = p.id
       JOIN Locations l ON plo.location_id = l.id
       ${where}`, params
    );
    return success(res, result);
  } catch (err) { next(err); }
};

module.exports = {
  getCategories, getProducts, getProductById, getFeaturedProducts,
  getToppings, getCrusts, uploadProductImage,
  setProductLocationAvailability, getProductLocationOverrides,
};
