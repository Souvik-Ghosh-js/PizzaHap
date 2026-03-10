const { query } = require('../config/db');
const { success, created, badRequest, notFound } = require('../utils/response');
const { initiatePayURefund } = require('./paymentController');

const requestRefund = async (req, res, next) => {
  try {
    const { order_id, reason } = req.body;
    const userId = req.user.id;

    const orderResult = await query(
      `SELECT o.*, p.id as payment_db_id, p.gateway_payment_id, p.amount as paid_amount
       FROM Orders o LEFT JOIN Payments p ON p.order_id = o.id AND p.status = 'captured'
       WHERE o.id = ? AND o.user_id = ?`,
      [order_id, userId]
    );
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];

    if (!['cancelled', 'delivered'].includes(order.status) && order.payment_status !== 'paid') {
      return badRequest(res, 'Order is not eligible for refund');
    }

    const existingRefund = await query(`SELECT id FROM Refunds WHERE order_id = ? AND status NOT IN ('failed')`, [order_id]);
    if (existingRefund.length) return badRequest(res, 'Refund already requested for this order');

    if (!order.gateway_payment_id) {
      return badRequest(res, 'No online payment found for this order. COD refunds handled manually.');
    }

    const result = await query(
      `INSERT INTO Refunds (order_id, payment_id, amount, reason, status, requested_by) VALUES (?, ?, ?, ?, 'pending', ?)`,
      [order_id, order.payment_db_id, order.paid_amount, reason, userId]
    );
    return created(res, { refund_id: result.insertId }, 'Refund request submitted. Processing within 3-5 business days.');
  } catch (err) { next(err); }
};

const getMyRefunds = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT r.*, o.order_number FROM Refunds r JOIN Orders o ON r.order_id = o.id
       WHERE r.requested_by = ? ORDER BY r.requested_at DESC`,
      [req.user.id]
    );
    return success(res, result);
  } catch (err) { next(err); }
};

const getAllRefunds = async (req, res, next) => {
  try {
    const { status } = req.query;
    let whereClause = '';
    const params = [];
    if (status) { whereClause = 'WHERE r.status = ?'; params.push(status); }
    const result = await query(
      `SELECT r.*, o.order_number, u.name as user_name, u.email as user_email
       FROM Refunds r JOIN Orders o ON r.order_id = o.id JOIN Users u ON r.requested_by = u.id
       ${whereClause} ORDER BY r.requested_at DESC`,
      params
    );
    return success(res, result);
  } catch (err) { next(err); }
};

const processRefund = async (req, res, next) => {
  try {
    const { action, notes } = req.body;
    const refundResult = await query(
      `SELECT r.*, p.gateway_payment_id FROM Refunds r JOIN Payments p ON r.payment_id = p.id
       WHERE r.id = ? AND r.status = 'pending'`,
      [req.params.id]
    );
    if (!refundResult.length) return notFound(res, 'Refund request not found or already processed');
    const refund = refundResult[0];

    if (action === 'reject') {
      await query(
        `UPDATE Refunds SET status = 'failed', processed_by = ?, processed_at = NOW(), notes = ? WHERE id = ?`,
        [req.admin.id, notes || 'Refund rejected by admin', refund.id]
      );
      return success(res, {}, 'Refund rejected');
    }

    // Process via PayU
    const payuRefund = await initiatePayURefund({
      mihpayid: refund.gateway_payment_id,
      amount: refund.amount,
      refundId: refund.id,
    });

    await query(
      `UPDATE Refunds SET status = 'processing', processed_by = ?, processed_at = NOW(), notes = ? WHERE id = ?`,
      [req.admin.id, notes || 'Refund processed', refund.id]
    );
    await query(`UPDATE Orders SET payment_status = 'refunded' WHERE id = ?`, [refund.order_id]);

    return success(res, { payu_refund: payuRefund }, 'Refund initiated successfully');
  } catch (err) { next(err); }
};

module.exports = { requestRefund, getMyRefunds, getAllRefunds, processRefund };
