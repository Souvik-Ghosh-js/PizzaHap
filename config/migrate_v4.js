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
  console.log('🚀 Running v4 migrations...');

  // 1. DeliveryRiders: Add email
  await addColumnIfMissing(pool, 'DeliveryRiders', 'email', 'VARCHAR(150) NULL');

  // 2. Products: Add stock_quantity
  await addColumnIfMissing(pool, 'Products', 'stock_quantity', 'INT DEFAULT 0');

  // 3. Ensure ProductLocationAvailability exists (it was in migrateExtra in migrate.js)
  if (!await tableExists(pool, 'ProductLocationAvailability')) {
    await pool.execute(`
      CREATE TABLE ProductLocationAvailability (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        location_id INT NOT NULL,
        is_available TINYINT(1) DEFAULT 1,
        updated_at DATETIME DEFAULT NOW(),
        UNIQUE KEY unique_product_location (product_id, location_id),
        FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
      )
    `);
    console.log('OK    ProductLocationAvailability table created');
  } else {
    console.log('SKIP  ProductLocationAvailability already exists');
  }

  console.log('\n✅ v4 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
