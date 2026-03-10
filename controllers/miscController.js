const { query } = require('../config/db');
const { success, created, badRequest, notFound, conflict } = require('../utils/response');

const submitRating = async (req, res, next) => {
  try {
    const { order_id, product_id, rating, review } = req.body;
    const orderCheck = await query(
      `SELECT id FROM Orders WHERE id = ? AND user_id = ? AND status = 'delivered'`,
      [order_id, req.user.id]
    );
    if (!orderCheck.length) return badRequest(res, 'Can only rate delivered orders');

    const existing = await query(
      `SELECT id FROM Ratings WHERE order_id = ? AND user_id = ? AND product_id = ?`,
      [order_id, req.user.id, product_id]
    );
    if (existing.length) return conflict(res, 'Already rated this item');

    await query(
      `INSERT INTO Ratings (user_id, order_id, product_id, rating, review) VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, order_id, product_id, rating, review || null]
    );
    return created(res, {}, 'Thank you for your rating!');
  } catch (err) { next(err); }
};

const getProductRatings = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT r.rating, r.review, r.created_at, u.name as user_name
       FROM Ratings r JOIN Users u ON r.user_id = u.id
       WHERE r.product_id = ? AND r.is_approved = 1 ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    const avg = result.length ? (result.reduce((s, r) => s + r.rating, 0) / result.length).toFixed(1) : null;
    return success(res, { avg_rating: avg, reviews: result });
  } catch (err) { next(err); }
};

const getNotifications = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM Notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unread = result.filter(n => !n.is_read).length;
    return success(res, { notifications: result, unread_count: unread });
  } catch (err) { next(err); }
};

const markAllRead = async (req, res, next) => {
  try {
    await query(`UPDATE Notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [req.user.id]);
    return success(res, {}, 'All notifications marked as read');
  } catch (err) { next(err); }
};

const markOneRead = async (req, res, next) => {
  try {
    await query(`UPDATE Notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    return success(res, {}, 'Notification marked as read');
  } catch (err) { next(err); }
};

const validateCoupon = async (req, res, next) => {
  try {
    const { code, order_value } = req.body;
    const result = await query(
      `SELECT * FROM Coupons WHERE code = ? AND is_active = 1
       AND valid_from <= NOW() AND valid_until >= NOW()
       AND (usage_limit IS NULL OR used_count < usage_limit)`,
      [code.toUpperCase()]
    );
    if (!result.length) return badRequest(res, 'Invalid or expired coupon');
    const coupon = result[0];

    if (parseFloat(order_value) < coupon.min_order_value) {
      return badRequest(res, `Minimum order of ₹${coupon.min_order_value} required`);
    }

    const usageCheck = await query(
      `SELECT COUNT(*) as count FROM UserCouponUsage WHERE coupon_id = ? AND user_id = ?`,
      [coupon.id, req.user.id]
    );
    if (usageCheck[0].count >= coupon.per_user_limit) {
      return badRequest(res, 'You have already used this coupon');
    }

    let discount = coupon.discount_type === 'percentage'
      ? Math.min((order_value * coupon.discount_value) / 100, coupon.max_discount || Infinity)
      : coupon.discount_value;

    return success(res, {
      coupon_id: coupon.id, code: coupon.code,
      discount_type: coupon.discount_type, discount_value: coupon.discount_value,
      calculated_discount: parseFloat(discount.toFixed(2)), description: coupon.description,
    });
  } catch (err) { next(err); }
};

const getActiveCoupons = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT code, description, discount_type, discount_value, min_order_value, valid_until
      FROM Coupons
      WHERE is_active = 1 AND valid_from <= NOW() AND valid_until >= NOW()
        AND (usage_limit IS NULL OR used_count < usage_limit)
      ORDER BY created_at DESC
    `);
    return success(res, result);
  } catch (err) { next(err); }
};

const generateInvoice = async (req, res, next) => {
  try {
    const orderResult = await query(
      `SELECT o.*, u.name, u.email, u.mobile, l.name as branch
       FROM Orders o JOIN Users u ON o.user_id = u.id JOIN Locations l ON o.location_id = l.id
       WHERE o.id = ? AND o.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];

    const items = await query(
      `SELECT oi.*, GROUP_CONCAT(oit.topping_name SEPARATOR ', ') as toppings_list
       FROM OrderItems oi LEFT JOIN OrderItemToppings oit ON oit.order_item_id = oi.id
       WHERE oi.order_id = ? GROUP BY oi.id`,
      [order.id]
    );

    const cgst = parseFloat((order.tax_amount / 2).toFixed(2));
    const sgst = parseFloat((order.tax_amount / 2).toFixed(2));

    return success(res, {
      invoice_number: `INV-${order.order_number}`,
      order_number: order.order_number,
      customer: { name: order.name, email: order.email, mobile: order.mobile },
      branch: order.branch, items,
      subtotal: order.subtotal, discount: order.discount_amount,
      delivery_fee: order.delivery_fee, cgst, sgst, total: order.total_amount, date: order.created_at,
    });
  } catch (err) { next(err); }
};

module.exports = {
  submitRating, getProductRatings,
  getNotifications, markAllRead, markOneRead,
  validateCoupon, getActiveCoupons,
  generateInvoice,
};
