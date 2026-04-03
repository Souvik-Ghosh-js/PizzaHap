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

    const lid = location_id ? parseInt(location_id) : 'NULL';

    const countRes = await query(`SELECT COUNT(*) as total FROM Products p ${where}`, params);
    const rows = await query(
      `SELECT p.*, c.name as category_name, c.has_toppings, c.has_crust,
              1 as location_available,
              (
                SELECT COALESCE(MIN(COALESCE(plp.price, ps.price)), p.base_price)
                FROM ProductSizes ps
                LEFT JOIN ProductLocationPricing plp ON plp.product_size_id = ps.id AND plp.location_id = ${lid}
                WHERE ps.product_id = p.id AND ps.is_available = 1
              ) as min_price
       FROM Products p
       LEFT JOIN Categories c ON p.category_id = c.id
       ${where}
       ORDER BY p.sort_order, p.name
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    
    const processedRows = rows.map(r => ({
      ...r,
      base_price: r.min_price !== null ? r.min_price : r.base_price
    }));
    
    return paginated(res, processedRows, countRes[0].total, page, limit);
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
      // Products are available globally
    }

    const lid = location_id ? parseInt(location_id) : null;

    const sizesPromise = lid
      ? query(
          `SELECT ps.*, COALESCE(plp.price, ps.price) as effective_price
           FROM ProductSizes ps
           LEFT JOIN ProductLocationPricing plp ON plp.product_size_id = ps.id AND plp.location_id = ?
           WHERE ps.product_id = ? AND ps.is_available = 1`,
          [lid, product.id])
      : query(`SELECT *, price as effective_price FROM ProductSizes WHERE product_id = ? AND is_available = 1`, [product.id]);

    const ratingsPromise = query(
      `SELECT r.*, u.name as user_name FROM Ratings r LEFT JOIN Users u ON r.user_id = u.id
       WHERE r.product_id = ? AND r.is_approved = 1 ORDER BY r.created_at DESC`,
      [product.id]
    );

    // Only fetch crusts/toppings if the category has them enabled, with location pricing
    const crustsPromise = product.has_crust
      ? (lid
          ? query(`SELECT ct.*, COALESCE(clp.extra_price, ct.extra_price) as effective_extra_price FROM CrustTypes ct LEFT JOIN CrustLocationPricing clp ON clp.crust_id = ct.id AND clp.location_id = ? WHERE ct.is_available = 1 ORDER BY ct.sort_order`, [lid])
          : query(`SELECT *, extra_price as effective_extra_price FROM CrustTypes WHERE is_available = 1 ORDER BY sort_order`))
      : Promise.resolve([]);
    const toppingsPromise = product.has_toppings
      ? (lid
          ? query(`SELECT t.*, COALESCE(tlp.price, t.price) as effective_price FROM Toppings t LEFT JOIN ToppingLocationPricing tlp ON tlp.topping_id = t.id AND tlp.location_id = ? WHERE t.is_available = 1 ORDER BY t.sort_order`, [lid])
          : query(`SELECT *, price as effective_price FROM Toppings WHERE is_available = 1 ORDER BY sort_order`))
      : Promise.resolve([]);

    // Size-specific pricing for crusts and toppings, with location override
    const crustSizePricingPromise = product.has_crust
      ? (lid
          ? query(
              `SELECT csp.crust_id, csp.size_code, COALESCE(clsp.extra_price, csp.extra_price) as extra_price
               FROM CrustSizePricing csp
               LEFT JOIN CrustLocationSizePricing clsp ON clsp.crust_id = csp.crust_id AND clsp.size_code = csp.size_code AND clsp.location_id = ?`,
              [lid]
            )
          : query(`SELECT crust_id, size_code, extra_price FROM CrustSizePricing`))
      : Promise.resolve([]);

    const toppingSizePricingPromise = product.has_toppings
      ? (lid
          ? query(
              `SELECT tsp.topping_id, tsp.size_code, COALESCE(tlsp.price, tsp.price) as price
               FROM ToppingSizePricing tsp
               LEFT JOIN ToppingLocationSizePricing tlsp ON tlsp.topping_id = tsp.topping_id AND tlsp.size_code = tsp.size_code AND tlsp.location_id = ?`,
              [lid]
            )
          : query(`SELECT topping_id, size_code, price FROM ToppingSizePricing`))
      : Promise.resolve([]);

    const [sizes, crusts, toppings, ratings, crustSizePricing, toppingSizePricing] = await Promise.all([
      sizesPromise, crustsPromise, toppingsPromise, ratingsPromise,
      crustSizePricingPromise, toppingSizePricingPromise,
    ]);

    const avgRating = ratings.length
      ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1)
      : null;

    return success(res, {
      ...product, sizes, crusts, toppings,
      crust_size_pricing: crustSizePricing,
      topping_size_pricing: toppingSizePricing,
      avg_rating: avgRating, review_count: ratings.length,
      reviews: ratings.slice(0, 5),
    });
  } catch (err) { next(err); }
};

const getFeaturedProducts = async (req, res, next) => {
  try {
    const { location_id } = req.query;
    const lid = location_id ? parseInt(location_id) : null;
    const lidSql = lid !== null ? lid : 'NULL';
    const rows = await query(
      `SELECT p.*, c.name as category_name, c.has_toppings, c.has_crust,
              (
                SELECT COALESCE(MIN(COALESCE(plp.price, ps.price)), p.base_price)
                FROM ProductSizes ps
                LEFT JOIN ProductLocationPricing plp ON plp.product_size_id = ps.id AND plp.location_id = ${lidSql}
                WHERE ps.product_id = p.id AND ps.is_available = 1
              ) as min_price
       FROM Products p LEFT JOIN Categories c ON p.category_id = c.id
       WHERE p.is_featured = 1 AND p.is_available = 1
       ORDER BY p.sort_order LIMIT 10`
    );
    
    const processedRows = rows.map(r => ({
      ...r,
      base_price: r.min_price !== null ? r.min_price : r.base_price
    }));
    
    return success(res, processedRows);
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

const getActiveBanners = async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT * FROM Banners WHERE is_active = 1
       AND (valid_from IS NULL OR valid_from <= NOW())
       AND (valid_until IS NULL OR valid_until >= NOW())
       ORDER BY sort_order, id`
    );
    return success(res, rows);
  } catch (err) { next(err); }
};

module.exports = { getCategories, getProducts, getProductById, getFeaturedProducts, getToppings, getCrusts, getActiveBanners };
