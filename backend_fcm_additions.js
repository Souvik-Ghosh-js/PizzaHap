// ════════════════════════════════════════════════════════════════
// ADD THESE TO YOUR BACKEND (Node.js / PizzaHap server)
// ════════════════════════════════════════════════════════════════

// 1. Install: npm install firebase-admin

// 2. Add to your .env:
//    FIREBASE_PROJECT_ID=device-streaming-a4f3601d
//    FIREBASE_CLIENT_EMAIL=<from Firebase service account JSON>
//    FIREBASE_PRIVATE_KEY=<from Firebase service account JSON>

// ─── services/fcmService.js ───────────────────────────────────────
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// Send to a single FCM token
const sendToToken = async (token, title, body, data = {}) => {
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'pizzahap_orders', color: '#CC1F1F' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
    return true;
  } catch (err) {
    console.error('FCM send error:', err.message);
    return false;
  }
};

// Send to multiple tokens
const sendToTokens = async (tokens, title, body, data = {}) => {
  if (!tokens.length) return;
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));
  for (const chunk of chunks) {
    await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'pizzahap_orders', color: '#CC1F1F' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
  }
};

// Send to topic (all users subscribed to 'all_users')
const sendToAll = async (title, body, data = {}) => {
  try {
    await admin.messaging().send({
      topic: 'all_users',
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'pizzahap_orders', color: '#CC1F1F' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
    return true;
  } catch (err) {
    console.error('FCM broadcast error:', err.message);
    return false;
  }
};

module.exports = { sendToToken, sendToTokens, sendToAll };


// ─── Add to authController.js ─────────────────────────────────────
// PUT /auth/fcm-token  (protected)
const saveFcmToken = async (req, res, next) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token) return badRequest(res, 'FCM token required');
    await query(`UPDATE Users SET fcm_token = ? WHERE id = ?`, [fcm_token, req.user.id]);

    // Subscribe to 'all_users' topic for broadcast notifications
    const admin = require('firebase-admin');
    await admin.messaging().subscribeToTopic([fcm_token], 'all_users');

    return success(res, {}, 'FCM token saved');
  } catch (err) { next(err); }
};


// ─── Add to orderController.js ────────────────────────────────────
// Call this after order status changes:
const notifyOrderStatusChange = async (orderId, status, userId) => {
  const { sendToToken } = require('../services/fcmService');
  const { query } = require('../config/db');

  const statusMessages = {
    confirmed:        { title: '✅ Order Confirmed!',      body: 'Your order has been confirmed and will be prepared soon.' },
    preparing:        { title: '👨‍🍳 Preparing Your Order', body: 'Our chefs are preparing your delicious pizza!' },
    out_for_delivery: { title: '🛵 Out for Delivery!',     body: 'Your order is on its way. Get ready!' },
    delivered:        { title: '🎉 Order Delivered!',      body: 'Enjoy your meal! Don\'t forget to rate your order.' },
    cancelled:        { title: '❌ Order Cancelled',       body: 'Your order has been cancelled.' },
  };

  const msg = statusMessages[status];
  if (!msg) return;

  const userResult = await query(`SELECT fcm_token FROM Users WHERE id = ?`, [userId]);
  const token = userResult[0]?.fcm_token;
  if (token) {
    await sendToToken(token, msg.title, msg.body, { type: 'order', id: String(orderId) });
  }

  // Also insert into Notifications table
  await query(
    `INSERT INTO Notifications (user_id, title, message, type) VALUES (?, ?, ?, 'order')`,
    [userId, msg.title, msg.body]
  );
};


// ─── Add to adminRoutes.js ────────────────────────────────────────
// POST /admin/notifications/send      → send to specific user
// POST /admin/notifications/broadcast → send to all users
const sendAdminNotification = async (req, res, next) => {
  try {
    const { user_id, title, body, data } = req.body;
    const { sendToToken } = require('../services/fcmService');
    const { query } = require('../config/db');

    const userResult = await query(`SELECT fcm_token FROM Users WHERE id = ?`, [user_id]);
    const token = userResult[0]?.fcm_token;
    if (!token) return badRequest(res, 'User has no FCM token registered');

    await sendToToken(token, title, body, data || {});
    await query(
      `INSERT INTO Notifications (user_id, title, message, type) VALUES (?, ?, ?, 'promo')`,
      [user_id, title, body]
    );
    return success(res, {}, 'Notification sent');
  } catch (err) { next(err); }
};

const broadcastNotification = async (req, res, next) => {
  try {
    const { title, body, data } = req.body;
    const { sendToAll } = require('../services/fcmService');
    await sendToAll(title, body, data || {});

    // Insert into Notifications for all users
    const { query } = require('../config/db');
    await query(`INSERT INTO Notifications (user_id, title, message, type)
      SELECT id, ?, ?, 'promo' FROM Users WHERE is_active = 1`, [title, body]);

    return success(res, {}, 'Broadcast sent');
  } catch (err) { next(err); }
};

// Add these routes in adminRoutes.js:
// router.post('/notifications/send', authenticateAdmin, sendAdminNotification);
// router.post('/notifications/broadcast', authenticateAdmin, broadcastNotification);

// Add this route in authRoutes.js:
// router.put('/fcm-token', authenticate, saveFcmToken);

// Add fcm_token column to Users table:
// ALTER TABLE Users ADD COLUMN fcm_token VARCHAR(512) NULL DEFAULT NULL;
