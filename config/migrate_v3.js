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
  console.log('Running v3 migrations...');

  // ── DeliveryRiders table ────────────────────────────────────────
  if (!await tableExists(pool, 'DeliveryRiders')) {
    await pool.execute(`
      CREATE TABLE DeliveryRiders (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        phone       VARCHAR(20) NOT NULL,
        location_id INT,
        is_active   TINYINT(1) DEFAULT 1,
        created_at  DATETIME DEFAULT NOW(),
        updated_at  DATETIME DEFAULT NOW(),
        FOREIGN KEY (location_id) REFERENCES Locations(id)
      )
    `);
    console.log('OK    DeliveryRiders table created');
  } else {
    console.log('SKIP  DeliveryRiders already exists');
  }

  // ── Orders: rider_id, customer_name, customer_phone ─────────────
  await addColumnIfMissing(pool, 'Orders', 'rider_id',       'INT NULL');
  await addColumnIfMissing(pool, 'Orders', 'customer_name',  'VARCHAR(100) NULL');
  await addColumnIfMissing(pool, 'Orders', 'customer_phone', 'VARCHAR(20) NULL');

  // Add FK for rider_id only if DeliveryRiders exists
  try {
    await pool.execute(`ALTER TABLE Orders ADD CONSTRAINT fk_orders_rider FOREIGN KEY (rider_id) REFERENCES DeliveryRiders(id) ON DELETE SET NULL`);
    console.log('OK    Orders.rider_id FK added');
  } catch (e) {
    console.warn('SKIP  Orders.rider_id FK:', e.message);
  }

  // ── Coupons: extend discount_type ENUM to include buy_1_get_1 ───
  try {
    await pool.execute(`ALTER TABLE Coupons MODIFY COLUMN discount_type ENUM('percentage','flat','buy_1_get_1') NOT NULL`);
    console.log('OK    Coupons.discount_type ENUM extended with buy_1_get_1');
  } catch (e) {
    console.warn('SKIP  Coupons ENUM:', e.message);
  }

  console.log('\nv3 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('v3 migration failed:', err);
  process.exit(1);
});
