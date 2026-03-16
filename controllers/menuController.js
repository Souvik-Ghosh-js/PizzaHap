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
    const { category_id, is_veg, search, location_id } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let where  = `WHERE p.is_available = 1`;
    const params = [];

    if (category_id) { where += ` AND p.category_id = ?`; params.push(parseInt(category_id)); }
    if (is_veg !== undefined) { where += ` AND p.is_veg = ?`; params.push(is_veg === 'true' ? 1 : 0); }
    if (search) {
      where += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    let joinClause = '';
    if (location_id) {
      const lid = parseInt(location_id);
      joinClause = `LEFT JOIN ProductLocationAvailability pla ON pla.product_id = p.id AND pla.location_id = ${lid}`;
      where += ` AND (pla.is_available IS NULL OR pla.is_available = 1)`;
    }

    const countRes = await query(`SELECT COUNT(*) as total FROM Products p ${joinClause} ${where}`, params);
    const rows = await query(
      `SELECT p.*, c.name as category_name, c.has_toppings, c.has_crust,
              COALESCE(pla.is_available, 1) as location_available
       FROM Products p
       LEFT JOIN Categories c ON p.category_id = c.id
       ${joinClause}
       ${where}
       ORDER BY p.sort_order, p.name
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return paginated(res, rows, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const getProductById = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    const rows = await query(
      `SELECT p.*, c.name as category_name, c.has_toppings, c.has_crust
       FROM Products p LEFT JOIN Categories c ON p.category_id = c.id
       WHERE p.id = ? AND p.is_available = 1`,
      [req.params.id]
    );
    if (!rows.length) return notFound(res, 'Product not found');
    const product = rows[0];

    if (location_id) {
      const avail = await query(
        `SELECT is_available FROM ProductLocationAvailability WHERE product_id = ? AND location_id = ?`,
        [product.id, parseInt(location_id)]
      );
      if (avail.length && !avail[0].is_available) return notFound(res, 'Product not available at this location');
    }

    const sizesPromise   = query(`SELECT * FROM ProductSizes WHERE product_id = ? AND is_available = 1`, [product.id]);
    const ratingsPromise = query(
      `SELECT r.*, u.name as user_name FROM Ratings r LEFT JOIN Users u ON r.user_id = u.id
       WHERE r.product_id = ? AND r.is_approved = 1 ORDER BY r.created_at DESC`,
      [product.id]
    );

    // Only fetch crusts/toppings if the category has them enabled
    const crustsPromise  = product.has_crust    ? query(`SELECT * FROM CrustTypes WHERE is_available = 1 ORDER BY sort_order`) : Promise.resolve([]);
    const toppingsPromise= product.has_toppings ? query(`SELECT * FROM Toppings   WHERE is_available = 1 ORDER BY sort_order`) : Promise.resolve([]);

    const [sizes, crusts, toppings, ratings] = await Promise.all([sizesPromise, crustsPromise, toppingsPromise, ratingsPromise]);

    const avgRating = ratings.length
      ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1)
      : null;

    return success(res, {
      ...product, sizes, crusts, toppings,
      avg_rating: avgRating, review_count: ratings.length,
      reviews: ratings.slice(0, 5),
    });
  } catch (err) { next(err); }
};

const getFeaturedProducts = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    let joinClause = '', whereExtra = '';
    if (location_id) {
      const lid = parseInt(location_id);
      joinClause = `LEFT JOIN ProductLocationAvailability pla ON pla.product_id = p.id AND pla.location_id = ${lid}`;
      whereExtra = ` AND (pla.is_available IS NULL OR pla.is_available = 1)`;
    }
    const rows = await query(
      `SELECT p.*, c.name as category_name, c.has_toppings, c.has_crust
       FROM Products p LEFT JOIN Categories c ON p.category_id = c.id
       ${joinClause}
       WHERE p.is_featured = 1 AND p.is_available = 1${whereExtra}
       ORDER BY p.sort_order LIMIT 10`
    );
    return success(res, rows);
  } catch (err) { next(err); }
};

const getToppings = async (req, res, next) => {
  try {
    const { is_veg } = req.query;
    let where = 'WHERE is_available = 1';
    const params = [];
    if (is_veg !== undefined) { where += ' AND is_veg = ?'; params.push(is_veg === 'true' ? 1 : 0); }
    const rows = await query(`SELECT * FROM Toppings ${where} ORDER BY sort_order`, params);
    return success(res, rows);
  } catch (err) { next(err); }
};

const getCrusts = async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM CrustTypes WHERE is_available = 1 ORDER BY sort_order`);
    return success(res, rows);
  } catch (err) { next(err); }
};

module.exports = { getCategories, getProducts, getProductById, getFeaturedProducts, getToppings, getCrusts };
