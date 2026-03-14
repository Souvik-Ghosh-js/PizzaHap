const { query } = require('../config/db');
const { success, notFound, paginated } = require('../utils/response');

const getCategories = async (req, res, next) => {
  try {
    const result = await query(`SELECT * FROM Categories WHERE is_active = 1 ORDER BY sort_order`);
    return success(res, result);
  } catch (err) { next(err); }
};

const getProducts = async (req, res, next) => {
  try {
    const { category_id, is_veg, search } = req.query;
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = `WHERE p.is_available = 1`;
    const params = [];

    if (category_id) {
      whereClause += ` AND p.category_id = ?`;
      params.push(parseInt(category_id));
    }
    if (is_veg !== undefined) {
      whereClause += ` AND p.is_veg = ?`;
      params.push(is_veg === 'true' ? 1 : 0);
    }
    if (search) {
      whereClause += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM Products p ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    const result = await query(
      `SELECT p.*, c.name as category_name
       FROM Products p LEFT JOIN Categories c ON p.category_id = c.id
       ${whereClause} ORDER BY p.sort_order, p.name
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return paginated(res, result, total, page, limit);
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
      ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1)
      : null;

    return success(res, {
      ...product, sizes, crusts, toppings,
      avg_rating: avgRating, review_count: ratings.length, reviews: ratings.slice(0, 5),
    });
  } catch (err) { next(err); }
};

const getFeaturedProducts = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.*, c.name as category_name FROM Products p
       LEFT JOIN Categories c ON p.category_id = c.id
       WHERE p.is_featured = 1 AND p.is_available = 1 ORDER BY p.sort_order LIMIT 10`
    );
    return success(res, result);
  } catch (err) { next(err); }
};

const getToppings = async (req, res, next) => {
  try {
    const { is_veg } = req.query;
    let whereClause = 'WHERE is_available = 1';
    const params = [];
    if (is_veg !== undefined) {
      whereClause += ' AND is_veg = ?';
      params.push(is_veg === 'true' ? 1 : 0);
    }
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

module.exports = { getCategories, getProducts, getProductById, getFeaturedProducts, getToppings, getCrusts };