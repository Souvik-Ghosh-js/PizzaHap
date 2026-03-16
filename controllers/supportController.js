const { query } = require('../config/db');
const { success, created, badRequest, notFound, paginated } = require('../utils/response');

const generateTicketNumber = () => `TKT-${Date.now().toString().slice(-8)}`;

// ── User: create ticket ───────────────────────────────────────────
const createTicket = async (req, res, next) => {
  try {
    const { order_id, subject, category, message, priority = 'medium' } = req.body;
    const ticket_number = generateTicketNumber();

    const ticketResult = await query(
      `INSERT INTO SupportTickets (ticket_number, user_id, order_id, subject, category, priority)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ticket_number, req.user.id, order_id || null, subject, category, priority]
    );
    const ticketId = ticketResult.insertId;

    await query(
      `INSERT INTO SupportMessages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, 'user', ?)`,
      [ticketId, req.user.id, message]
    );

    return created(res, { ticket_id: ticketId, ticket_number }, 'Support ticket created');
  } catch (err) { next(err); }
};

// ── User: list my tickets ─────────────────────────────────────────
const getMyTickets = async (req, res, next) => {
  try {
    const { status } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    let where = `WHERE t.user_id = ?`;
    const params = [req.user.id];
    if (status) { where += ` AND t.status = ?`; params.push(status); }

    const countRes = await query(`SELECT COUNT(*) as total FROM SupportTickets t ${where}`, params);
    const result   = await query(
      `SELECT t.*, o.order_number
       FROM SupportTickets t LEFT JOIN Orders o ON t.order_id = o.id
       ${where} ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

// ── User: get single ticket with messages ─────────────────────────
const getTicketById = async (req, res, next) => {
  try {
    const ticketResult = await query(
      `SELECT t.*, o.order_number
       FROM SupportTickets t LEFT JOIN Orders o ON t.order_id = o.id
       WHERE t.id = ? AND t.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!ticketResult.length) return notFound(res, 'Ticket not found');

    const messages = await query(
      `SELECT sm.*,
         CASE WHEN sm.sender_role = 'user' THEN u.name ELSE a.name END as sender_name
       FROM SupportMessages sm
       LEFT JOIN Users  u ON sm.sender_role = 'user'  AND sm.sender_id = u.id
       LEFT JOIN Admins a ON sm.sender_role != 'user' AND sm.sender_id = a.id
       WHERE sm.ticket_id = ? ORDER BY sm.created_at ASC`,
      [req.params.id]
    );

    // Mark messages as read
    await query(
      `UPDATE SupportMessages SET is_read = 1 WHERE ticket_id = ? AND sender_role != 'user'`,
      [req.params.id]
    );

    return success(res, { ...ticketResult[0], messages });
  } catch (err) { next(err); }
};

// ── User: reply to ticket ─────────────────────────────────────────
const replyToTicket = async (req, res, next) => {
  try {
    const { message } = req.body;
    const ticketResult = await query(
      `SELECT * FROM SupportTickets WHERE id = ? AND user_id = ? AND status NOT IN ('closed')`,
      [req.params.id, req.user.id]
    );
    if (!ticketResult.length) return notFound(res, 'Ticket not found or closed');

    await query(
      `INSERT INTO SupportMessages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, 'user', ?)`,
      [req.params.id, req.user.id, message]
    );
    await query(
      `UPDATE SupportTickets SET status = 'in_progress', updated_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    return success(res, {}, 'Reply sent');
  } catch (err) { next(err); }
};

// ── Admin: list all tickets ───────────────────────────────────────
const adminGetAllTickets = async (req, res, next) => {
  try {
    const { status, priority } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];
    if (status)   { where += ' AND t.status = ?';   params.push(status); }
    if (priority) { where += ' AND t.priority = ?'; params.push(priority); }

    const countRes = await query(
      `SELECT COUNT(*) as total FROM SupportTickets t ${where}`, params
    );
    const result = await query(
      `SELECT t.*, u.name as user_name, u.email as user_email, o.order_number,
              (SELECT COUNT(*) FROM SupportMessages sm
               WHERE sm.ticket_id = t.id AND sm.sender_role = 'user' AND sm.is_read = 0) as unread_count
       FROM SupportTickets t
       JOIN  Users  u ON t.user_id  = u.id
       LEFT JOIN Orders o ON t.order_id = o.id
       ${where}
       ORDER BY
         FIELD(t.priority,'urgent','high','medium','low'),
         t.updated_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

// ── Admin: get single ticket with full message thread ─────────────
const adminGetTicketById = async (req, res, next) => {
  try {
    const ticketResult = await query(
      `SELECT t.*, u.name as user_name, u.email as user_email,
              u.mobile as user_mobile, o.order_number
       FROM SupportTickets t
       JOIN  Users  u ON t.user_id  = u.id
       LEFT JOIN Orders o ON t.order_id = o.id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!ticketResult.length) return notFound(res, 'Ticket not found');

    const messages = await query(
      `SELECT sm.*,
         CASE WHEN sm.sender_role = 'user' THEN u.name ELSE a.name END as sender_name
       FROM SupportMessages sm
       LEFT JOIN Users  u ON sm.sender_role = 'user'  AND sm.sender_id = u.id
       LEFT JOIN Admins a ON sm.sender_role != 'user' AND sm.sender_id = a.id
       WHERE sm.ticket_id = ? ORDER BY sm.created_at ASC`,
      [req.params.id]
    );

    // Mark user messages as read by admin
    await query(
      `UPDATE SupportMessages SET is_read = 1 WHERE ticket_id = ? AND sender_role = 'user' AND is_read = 0`,
      [req.params.id]
    );

    return success(res, { ...ticketResult[0], messages });
  } catch (err) { next(err); }
};

// ── Admin: reply to ticket ────────────────────────────────────────
const adminReplyTicket = async (req, res, next) => {
  try {
    const { message, status } = req.body;

    // Verify ticket exists
    const ticketResult = await query(`SELECT id FROM SupportTickets WHERE id = ?`, [req.params.id]);
    if (!ticketResult.length) return notFound(res, 'Ticket not found');

    await query(
      `INSERT INTO SupportMessages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, 'admin', ?)`,
      [req.params.id, req.admin.id, message]
    );

    if (status) {
      await query(
        `UPDATE SupportTickets
         SET status = ?, updated_at = NOW(),
             resolved_at = CASE WHEN ? IN ('resolved','closed') THEN NOW() ELSE resolved_at END,
             assigned_to = COALESCE(assigned_to, ?)
         WHERE id = ?`,
        [status, status, req.admin.id, req.params.id]
      );
    } else {
      await query(
        `UPDATE SupportTickets
         SET updated_at = NOW(), assigned_to = COALESCE(assigned_to, ?)
         WHERE id = ?`,
        [req.admin.id, req.params.id]
      );
    }

    return success(res, {}, 'Reply sent');
  } catch (err) { next(err); }
};

module.exports = {
  createTicket,
  getMyTickets,
  getTicketById,
  replyToTicket,
  adminGetAllTickets,
  adminGetTicketById,
  adminReplyTicket,
};