const { query } = require('../config/db');
const { success, created, badRequest, notFound, paginated } = require('../utils/response');

const generateTicketNumber = () => `TKT-${Date.now().toString().slice(-8)}`;

const createTicket = async (req, res, next) => {
  try {
    const { order_id, subject, category, message } = req.body;
    const ticket_number = generateTicketNumber();

    const ticketResult = await query(
      `INSERT INTO SupportTickets (ticket_number, user_id, order_id, subject, category) VALUES (?, ?, ?, ?, ?)`,
      [ticket_number, req.user.id, order_id || null, subject, category]
    );
    const ticketId = ticketResult.insertId;

    await query(
      `INSERT INTO SupportMessages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, 'user', ?)`,
      [ticketId, req.user.id, message]
    );
    return created(res, { ticket_id: ticketId, ticket_number }, 'Support ticket created');
  } catch (err) { next(err); }
};

const getMyTickets = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = `WHERE t.user_id = ?`;
    const params = [req.user.id];
    if (status) { whereClause += ` AND t.status = ?`; params.push(status); }

    const countRes = await query(`SELECT COUNT(*) as total FROM SupportTickets t ${whereClause}`, params);
    const result = await query(
      `SELECT t.*, o.order_number FROM SupportTickets t LEFT JOIN Orders o ON t.order_id = o.id
       ${whereClause} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const getTicketById = async (req, res, next) => {
  try {
    const ticketResult = await query(
      `SELECT t.*, o.order_number FROM SupportTickets t LEFT JOIN Orders o ON t.order_id = o.id
       WHERE t.id = ? AND t.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!ticketResult.length) return notFound(res, 'Ticket not found');

    const messages = await query(
      `SELECT sm.*,
        CASE WHEN sm.sender_role = 'user' THEN u.name ELSE a.name END as sender_name
       FROM SupportMessages sm
       LEFT JOIN Users u ON sm.sender_role = 'user' AND sm.sender_id = u.id
       LEFT JOIN Admins a ON sm.sender_role != 'user' AND sm.sender_id = a.id
       WHERE sm.ticket_id = ? ORDER BY sm.created_at ASC`,
      [req.params.id]
    );
    return success(res, { ...ticketResult[0], messages });
  } catch (err) { next(err); }
};

const replyToTicket = async (req, res, next) => {
  try {
    const { message } = req.body;
    const ticketResult = await query(
      `SELECT * FROM SupportTickets WHERE id = ? AND user_id = ? AND status NOT IN ('closed')`,
      [req.params.id, req.user.id]
    );
    if (!ticketResult.length) return notFound(res, 'Ticket not found or closed');

    await query(`INSERT INTO SupportMessages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, 'user', ?)`, [req.params.id, req.user.id, message]);
    await query(`UPDATE SupportTickets SET status = 'in_progress', updated_at = NOW() WHERE id = ?`, [req.params.id]);
    return success(res, {}, 'Reply sent');
  } catch (err) { next(err); }
};

const adminGetAllTickets = async (req, res, next) => {
  try {
    const { status, priority, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = 'WHERE 1=1';
    const params = [];
    if (status) { whereClause += ' AND t.status = ?'; params.push(status); }
    if (priority) { whereClause += ' AND t.priority = ?'; params.push(priority); }

    const countRes = await query(`SELECT COUNT(*) as total FROM SupportTickets t ${whereClause}`, params);
    const result = await query(
      `SELECT t.*, u.name as user_name, u.email as user_email, o.order_number
       FROM SupportTickets t JOIN Users u ON t.user_id = u.id LEFT JOIN Orders o ON t.order_id = o.id
       ${whereClause} ORDER BY t.priority DESC, t.created_at ASC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    return paginated(res, result, countRes[0].total, page, limit);
  } catch (err) { next(err); }
};

const adminReplyTicket = async (req, res, next) => {
  try {
    const { message, status } = req.body;
    await query(`INSERT INTO SupportMessages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, 'admin', ?)`, [req.params.id, req.admin.id, message]);
    if (status) {
      await query(
        `UPDATE SupportTickets SET status = ?, updated_at = NOW(),
         resolved_at = CASE WHEN ? IN ('resolved','closed') THEN NOW() ELSE resolved_at END WHERE id = ?`,
        [status, status, req.params.id]
      );
    }
    return success(res, {}, 'Reply sent');
  } catch (err) { next(err); }
};

module.exports = { createTicket, getMyTickets, getTicketById, replyToTicket, adminGetAllTickets, adminReplyTicket };
