require('dotenv').config();
const { getPool } = require('./db');

const columnExists = async (pool, table, column) => {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].cnt > 0;
};

const tableExists = async (pool, table) => {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return rows[0].cnt > 0;
};

const addColumnIfMissing = async (pool, table, column, definition) => {
  if (await columnExists(pool, table, column)) {
    console.log(`SKIP  ${table}.${column} already exists`);
  } else {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`OK    ${table}.${column} added`);
  }
};

const migrate = async () => {
  const pool = getPool();
  console.log('Running v2 migrations...');

  // ── Users: structured address fields ───────────────────────────
  await addColumnIfMissing(pool, 'Users', 'address_house',   'VARCHAR(200) NULL');
  await addColumnIfMissing(pool, 'Users', 'address_town',    'VARCHAR(150) NULL');
  await addColumnIfMissing(pool, 'Users', 'address_state',   'VARCHAR(100) NULL');
  await addColumnIfMissing(pool, 'Users', 'address_pincode', 'VARCHAR(10)  NULL');

  // ── Orders: payment_method + coins columns ──────────────────────
  await addColumnIfMissing(pool, 'Orders', 'payment_method',  "ENUM('online','cash_on_delivery') DEFAULT 'online'");
  await addColumnIfMissing(pool, 'Orders', 'coins_redeemed',  'INT DEFAULT 0');
  await addColumnIfMissing(pool, 'Orders', 'coins_earned',    'INT DEFAULT 0');

  // ── Notifications: extend type ENUM to include 'coins' ─────────
  try {
    await pool.execute(`ALTER TABLE Notifications MODIFY COLUMN type ENUM('order','promo','system','refund','coins') NOT NULL`);
    console.log('OK    Notifications.type ENUM extended');
  } catch (e) {
    console.warn('SKIP  Notifications ENUM:', e.message);
  }

  // ── Orders: extend status ENUM to include 'refunded' ───────────
  try {
    await pool.execute(`ALTER TABLE Orders MODIFY COLUMN status ENUM('pending','confirmed','preparing','out_for_delivery','delivered','cancelled','refund_requested','refunded') DEFAULT 'pending'`);
    console.log('OK    Orders.status ENUM extended');
  } catch (e) {
    console.warn('SKIP  Orders status ENUM:', e.message);
  }

  // ── New tables ──────────────────────────────────────────────────
  if (!await tableExists(pool, 'UserCoins')) {
    await pool.execute(`
      CREATE TABLE UserCoins (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL UNIQUE,
        balance    INT NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
      )
    `);
    console.log('OK    UserCoins table created');
  } else {
    console.log('SKIP  UserCoins already exists');
  }

  if (!await tableExists(pool, 'CoinTransactions')) {
    await pool.execute(`
      CREATE TABLE CoinTransactions (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_id     INT NOT NULL,
        order_id    INT,
        type        ENUM('earned','redeemed','reverted') NOT NULL,
        coins       INT NOT NULL,
        description VARCHAR(300),
        created_at  DATETIME DEFAULT NOW(),
        FOREIGN KEY (user_id)  REFERENCES Users(id),
        FOREIGN KEY (order_id) REFERENCES Orders(id)
      )
    `);
    console.log('OK    CoinTransactions table created');
  } else {
    console.log('SKIP  CoinTransactions already exists');
  }

  if (!await tableExists(pool, 'OrderFeedback')) {
    await pool.execute(`
      CREATE TABLE OrderFeedback (
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
      )
    `);
    console.log('OK    OrderFeedback table created');
  } else {
    console.log('SKIP  OrderFeedback already exists');
  }

  if (!await tableExists(pool, 'AdminNotifications')) {
    await pool.execute(`
      CREATE TABLE AdminNotifications (
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
      )
    `);
    console.log('OK    AdminNotifications table created');
  } else {
    console.log('SKIP  AdminNotifications already exists');
  }

  console.log('\nv2 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('v2 migration failed:', err);
  process.exit(1);
});