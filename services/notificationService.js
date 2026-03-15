/**
 * notificationService.js
 * Central helper to create user + admin notifications in one call.
 */
const { query } = require('../config/db');

/**
 * Create a notification for a user.
 * @param {number} userId
 * @param {string} title
 * @param {string} message
 * @param {'order'|'promo'|'system'|'refund'|'coins'} type
 * @param {object|null} data  - extra JSON payload
 */
const notifyUser = async (userId, title, message, type = 'order', data = null) => {
  try {
    // Extend the ENUM on the fly if 'coins' is not yet there — handled by migration.
    // We fall back to 'system' if the type is unknown to avoid DB errors before migration.
    const safeType = ['order', 'promo', 'system', 'refund', 'coins'].includes(type) ? type : 'system';
    await query(
      `INSERT INTO Notifications (user_id, title, message, type, data) VALUES (?, ?, ?, ?, ?)`,
      [userId, title, message, safeType, data ? JSON.stringify(data) : null]
    );
  } catch (e) {
    console.error('notifyUser error:', e.message);
  }
};

/**
 * Create a notification for admin(s).
 * If location_id is provided, notifies all admins assigned to that location
 * AND super_admins (who have NULL location_id).
 * If location_id is null, notifies super_admins only.
 *
 * @param {number|null} locationId
 * @param {string} title
 * @param {string} message
 * @param {'order'|'payment'|'system'|'refund'} type
 * @param {object|null} data
 */
const notifyAdmins = async (locationId, title, message, type = 'order', data = null) => {
  try {
    // Fetch relevant admins
    let admins;
    if (locationId) {
      admins = await query(
        `SELECT id FROM Admins WHERE is_active = 1 AND (location_id = ? OR location_id IS NULL)`,
        [locationId]
      );
    } else {
      admins = await query(
        `SELECT id FROM Admins WHERE is_active = 1 AND location_id IS NULL`
      );
    }

    const safeType = ['order', 'payment', 'system', 'refund'].includes(type) ? type : 'system';
    const dataStr  = data ? JSON.stringify(data) : null;

    for (const admin of admins) {
      await query(
        `INSERT INTO AdminNotifications (admin_id, location_id, title, message, type, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [admin.id, locationId || null, title, message, safeType, dataStr]
      );
    }
  } catch (e) {
    console.error('notifyAdmins error:', e.message);
  }
};

/**
 * Credit coins to a user wallet.
 * Call this after order is marked 'delivered'.
 * @param {number} userId
 * @param {number} orderId
 * @param {number} coins
 */
const creditCoins = async (userId, orderId, coins) => {
  if (coins <= 0) return;
  try {
    // Upsert wallet
    await query(
      `INSERT INTO UserCoins (user_id, balance) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), updated_at = NOW()`,
      [userId, coins]
    );
    await query(
      `INSERT INTO CoinTransactions (user_id, order_id, type, coins, description)
       VALUES (?, ?, 'earned', ?, ?)`,
      [userId, orderId, coins, `Earned from order #${orderId}`]
    );
    // Update order record
    await query(`UPDATE Orders SET coins_earned = ? WHERE id = ?`, [coins, orderId]);

    // Notify user
    await notifyUser(
      userId,
      '🪙 Coins Credited!',
      `You earned ${coins} coins from your recent order. 1 coin = ₹1 on your next order!`,
      'coins',
      { order_id: orderId, coins }
    );
  } catch (e) {
    console.error('creditCoins error:', e.message);
  }
};

/**
 * Revert coins (on refund).
 * @param {number} userId
 * @param {number} orderId
 * @param {number} coins
 */
const revertCoins = async (userId, orderId, coins) => {
  if (coins <= 0) return;
  try {
    await query(
      `UPDATE UserCoins SET balance = GREATEST(0, balance - ?), updated_at = NOW() WHERE user_id = ?`,
      [coins, userId]
    );
    await query(
      `INSERT INTO CoinTransactions (user_id, order_id, type, coins, description)
       VALUES (?, ?, 'reverted', ?, ?)`,
      [userId, orderId, coins, `Coins reverted due to refund on order #${orderId}`]
    );
    await notifyUser(
      userId,
      '🪙 Coins Reverted',
      `${coins} coins have been deducted from your wallet due to a refund on order #${orderId}.`,
      'coins',
      { order_id: orderId, coins }
    );
  } catch (e) {
    console.error('revertCoins error:', e.message);
  }
};

module.exports = { notifyUser, notifyAdmins, creditCoins, revertCoins };
