require('dotenv').config();
const { getPool } = require('./db');

const tableExists = async (pool, table) => {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]
  );
  return rows[0].cnt > 0;
};

const migrate = async () => {
  const pool = getPool();
  console.log('Running v4 migrations...');

  // ── Ingredients (stock items) ────────────────────────────────────
  if (!await tableExists(pool, 'Ingredients')) {
    await pool.execute(`
      CREATE TABLE Ingredients (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        name                 VARCHAR(150) NOT NULL,
        unit                 VARCHAR(20) NOT NULL DEFAULT 'pieces' COMMENT 'pieces, kg, g, liters, ml',
        current_stock        DECIMAL(10,2) NOT NULL DEFAULT 0,
        low_stock_threshold  DECIMAL(10,2) NOT NULL DEFAULT 10,
        location_id          INT NULL COMMENT 'NULL = global ingredient',
        is_active            TINYINT(1) DEFAULT 1,
        created_at           DATETIME DEFAULT NOW(),
        updated_at           DATETIME DEFAULT NOW(),
        FOREIGN KEY (location_id) REFERENCES Locations(id)
      )
    `);
    console.log('OK    Ingredients table created');
  } else {
    console.log('SKIP  Ingredients already exists');
  }

  // ── ProductIngredients (recipe: how much of each ingredient per product unit) ──
  if (!await tableExists(pool, 'ProductIngredients')) {
    await pool.execute(`
      CREATE TABLE ProductIngredients (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        product_id      INT NOT NULL,
        ingredient_id   INT NOT NULL,
        quantity        DECIMAL(10,3) NOT NULL COMMENT 'amount consumed per 1 unit of this product',
        UNIQUE KEY uq_product_ingredient (product_id, ingredient_id),
        FOREIGN KEY (product_id)    REFERENCES Products(id) ON DELETE CASCADE,
        FOREIGN KEY (ingredient_id) REFERENCES Ingredients(id) ON DELETE CASCADE
      )
    `);
    console.log('OK    ProductIngredients table created');
  } else {
    console.log('SKIP  ProductIngredients already exists');
  }

  // ── StockLogs (audit trail of every stock change) ────────────────
  if (!await tableExists(pool, 'StockLogs')) {
    await pool.execute(`
      CREATE TABLE StockLogs (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        ingredient_id   INT NOT NULL,
        order_id        INT NULL,
        change_amount   DECIMAL(10,3) NOT NULL COMMENT 'negative = consumed, positive = restocked',
        stock_after     DECIMAL(10,2) NOT NULL,
        reason          VARCHAR(200),
        changed_by      INT NULL,
        created_at      DATETIME DEFAULT NOW(),
        FOREIGN KEY (ingredient_id) REFERENCES Ingredients(id),
        FOREIGN KEY (order_id)      REFERENCES Orders(id) ON DELETE SET NULL,
        FOREIGN KEY (changed_by)    REFERENCES Admins(id) ON DELETE SET NULL
      )
    `);
    console.log('OK    StockLogs table created');
  } else {
    console.log('SKIP  StockLogs already exists');
  }

  console.log('\nv4 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('v4 migration failed:', err);
  process.exit(1);
});
