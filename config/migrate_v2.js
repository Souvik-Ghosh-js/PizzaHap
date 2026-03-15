require('dotenv').config();
const { getPool } = require('./db');

/**
 * Migration v2 — run AFTER the original migrate.js
 * Adds: Coins system, OrderFeedback, AdminNotifications,
 *       structured address fields, payment_method + coins columns on Orders,
 *       'coins' type in Notifications ENUM.
 */
const migrate = async () => {
  const pool = getPool();
  console.log('Running v2 migrations...');

  // Run these one at a time so a partial failure is easier to diagnose
  const steps = [
    // Structured address fields on Users
    `ALTER TABLE Users ADD COLUMN IF NOT EXISTS address_house   VARCHAR(200) NULL`,
    `ALTER TABLE Users ADD COLUMN IF NOT EXISTS address_town    VARCHAR(150) NULL`,
    `ALTER TABLE Users ADD COLUMN IF NOT EXISTS address_state   VARCHAR(100) NULL`,
    `ALTER TABLE Users ADD COLUMN IF NOT EXISTS address_pincode VARCHAR(10)  NULL`,

    // payment_method + coins columns on Orders
    `ALTER TABLE Orders ADD COLUMN IF NOT EXISTS payment_method ENUM('online','cash_on_delivery') DEFAULT 'online'`,
    `ALTER TABLE Orders ADD COLUMN IF NOT EXISTS coins_redeemed INT DEFAULT 0`,
    `ALTER TABLE Orders ADD COLUMN IF NOT EXISTS coins_earned   INT DEFAULT 0`,

    // Extend Notifications type ENUM
    `ALTER TABLE Notifications MODIFY COLUMN type ENUM('order','promo','system','refund','coins') NOT NULL`,

    // Extend Orders status ENUM (add 'refunded' if missing)
    `ALTER TABLE Orders MODIFY COLUMN status ENUM('pending','confirmed','preparing','out_for_delivery','delivered','cancelled','refund_requested','refunded') DEFAULT 'pending'`,

    // UserCoins wallet
    `CREATE TABLE IF NOT EXISTS UserCoins (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL UNIQUE,
      balance    INT NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    )`,

    // Coin transaction ledger
    `CREATE TABLE IF NOT EXISTS CoinTransactions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      order_id    INT,
      type        ENUM('earned','redeemed','reverted') NOT NULL,
      coins       INT NOT NULL,
      description VARCHAR(300),
      created_at  DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id)  REFERENCES Users(id),
      FOREIGN KEY (order_id) REFERENCES Orders(id)
    )`,

    // Order-level feedback
    `CREATE TABLE IF NOT EXISTS OrderFeedback (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      order_id        INT NOT NULL UNIQUE,
      user_id         INT NOT NULL,
      food_rating     INT NOT NULL,
      delivery_rating INT,
      overall_rating  INT NOT NULL,
      comment         VARCHAR(1000),
      created_at      DATETIME DEFAULT NOW(),
      FOREIGN KEY (order_id) REFERENCES Orders(id),
      FOREIGN KEY (user_id)  REFERENCES Users(id)
    )`,

    // Admin notifications (location-scoped)
    `CREATE TABLE IF NOT EXISTS AdminNotifications (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      admin_id    INT,
      location_id INT,
      title       VARCHAR(200) NOT NULL,
      message     VARCHAR(1000) NOT NULL,
      type        ENUM('order','payment','system','refund') NOT NULL,
      is_read     TINYINT(1) DEFAULT 0,
      data        JSON,
      created_at  DATETIME DEFAULT NOW(),
      FOREIGN KEY (admin_id)    REFERENCES Admins(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES Locations(id)
    )`,
  ];

  for (const sql of steps) {
    try {
      await pool.execute(sql);
      console.log('OK:', sql.slice(0, 60).replace(/\s+/g, ' '));
    } catch (e) {
      // Duplicate column / already exists — safe to ignore
      if (e.code === 'ER_DUP_FIELDNAME' || e.message.includes('Duplicate column')) {
        console.warn('SKIP (already exists):', sql.slice(0, 60).replace(/\s+/g, ' '));
      } else {
        console.error('FAILED:', e.message, '\nSQL:', sql);
        throw e;
      }
    }
  }

  console.log('v2 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('v2 migration failed:', err);
  process.exit(1);
});
