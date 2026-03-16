const { query } = require('../config/db');
const { success, created, badRequest, notFound } = require('../utils/response');
const { initiatePayURefund } = require('./paymentController');
const { notifyUser, revertCoins } = require('../services/notificationService');

const requestRefund = async (req, res, next) => {
  try {
    const { order_id, reason } = req.body;
    const userId = req.user.id;

    const orderResult = await query(
      `SELECT o.*, p.id as payment_db_id, p.gateway_payment_id, p.amount as paid_amount
       FROM Orders o
       LEFT JOIN Payments p ON p.order_id = o.id AND p.status = 'captured'
       WHERE o.id = ? AND o.user_id = ?`,
      [order_id, userId]
    );
    if (!orderResult.length) return notFound(res, 'Order not found');
    const order = orderResult[0];

    // Allow refund if order cancelled with online payment, or delivered
    const eligible = (order.status === 'cancelled' && order.payment_status === 'paid')
                  || order.status === 'delivered';
    if (!eligible) return badRequest(res, 'Order is not eligible for refund');

    const existingRefund = await query(
      `SELECT id FROM Refunds WHERE order_id = ? AND status NOT IN ('failed')`, [order_id]
    );
    if (existingRefund.length) return badRequest(res, 'Refund already requested for this order');

    if (!order.gateway_payment_id) {
      return badRequest(res, 'No online payment found for this order. COD refunds are handled manually.');
    }

    const result = await query(
      `INSERT INTO Refunds (order_id, payment_id, amount, reason, status, requested_by) VALUES (?,?,?,?,'pending',?)`,
      [order_id, order.payment_db_id, order.paid_amount, reason, userId]
    );
    await query(`UPDATE Orders SET status = 'refund_requested', updated_at = NOW() WHERE id = ?`, [order_id]);
    await notifyUser(
      userId,
      'Refund Requested',
      `Your refund request for order #${order.order_number} has been submitted. Processing within 3-5 business days.`,
      'refund',
      { order_id }
    );
    return created(res, { refund_id: result.insertId }, 'Refund request submitted. Processing within 3-5 business days.');
  } catch (err) { next(err); }
};

const getMyRefunds = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT r.*, o.order_number
       FROM Refunds r JOIN Orders o ON r.order_id = o.id
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
      `SELECT r.*, o.order_number, o.coins_earned, o.user_id,
              u.name as user_name, u.email as user_email
       FROM Refunds r
       JOIN Orders o ON r.order_id = o.id
       JOIN Users u  ON r.requested_by = u.id
       ${whereClause}
       ORDER BY r.requested_at DESC`,
      params
    );
    return success(res, result);
  } catch (err) { next(err); }
};

const processRefund = async (req, res, next) => {
  try {
    const { action, notes } = req.body;
    const refundResult = await query(
      `SELECT r.*, p.gateway_payment_id, o.user_id, o.order_number, o.coins_earned
       FROM Refunds r
       JOIN Payments p ON r.payment_id = p.id
       JOIN Orders o   ON r.order_id   = o.id
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
      if (refund.user_id) {
        await notifyUser(refund.user_id, 'Refund Rejected',
          `Your refund for order #${refund.order_number} was not approved. ${notes || ''}`,
          'refund', { order_id: refund.order_id });
      }
      return success(res, {}, 'Refund rejected');
    }

    // Process via PayU
    let payuRefund = null;
    try {
      payuRefund = await initiatePayURefund({
        mihpayid: refund.gateway_payment_id,
        amount:   refund.amount,
        refundId: refund.id,
      });
    } catch (payuErr) {
      return badRequest(res, `PayU refund initiation failed: ${payuErr.message}`);
    }

    await query(
      `UPDATE Refunds SET status = 'processing', processed_by = ?, processed_at = NOW(), notes = ?,
       payu_refund_id = ? WHERE id = ?`,
      [req.admin.id, notes || 'Refund processed', payuRefund?.refundId || null, refund.id]
    );
    await query(
      `UPDATE Orders SET payment_status = 'refunded', status = 'refunded', updated_at = NOW() WHERE id = ?`,
      [refund.order_id]
    );

    // Revert any coins earned from this order
    if (refund.user_id && refund.coins_earned > 0) {
      await revertCoins(refund.user_id, refund.order_id, refund.coins_earned);
    }

    if (refund.user_id) {
      await notifyUser(
        refund.user_id,
        'Refund Initiated',
        `Your refund of Rs.${refund.amount} for order #${refund.order_number} has been initiated. It will reflect in 3-5 business days.`,
        'refund',
        { order_id: refund.order_id }
      );
    }

    return success(res, { payu_refund: payuRefund }, 'Refund initiated successfully');
  } catch (err) { next(err); }
};

module.exports = { requestRefund, getMyRefunds, getAllRefunds, processRefund };
