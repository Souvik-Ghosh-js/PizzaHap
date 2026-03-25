// rollback-v4.js
require('dotenv').config();
const { getPool } = require('./db');

const tableExists = async (pool, table) => {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]
  );
  return rows[0].cnt > 0;
};

const rollback = async () => {
  const pool = getPool();
  console.log('Rolling back v4 migrations...\n');

  // ── Drop tables in reverse order (respect foreign key constraints) ──

  // 1. StockLogs (depends on Ingredients, Orders, Admins)
  if (await tableExists(pool, 'StockLogs')) {
    await pool.execute('DROP TABLE StockLogs');
    console.log('✓ DROPPED StockLogs table');
  } else {
    console.log('SKIP  StockLogs does not exist');
  }

  // 2. ProductIngredients (depends on Products and Ingredients)
  if (await tableExists(pool, 'ProductIngredients')) {
    await pool.execute('DROP TABLE ProductIngredients');
    console.log('✓ DROPPED ProductIngredients table');
  } else {
    console.log('SKIP  ProductIngredients does not exist');
  }

  // 3. Ingredients (depends on Locations)
  if (await tableExists(pool, 'Ingredients')) {
    await pool.execute('DROP TABLE Ingredients');
    console.log('✓ DROPPED Ingredients table');
  } else {
    console.log('SKIP  Ingredients does not exist');
  }

  console.log('\n✅ v4 migrations rolled back successfully!');
  process.exit(0);
};

rollback().catch(err => {
  console.error('❌ v4 rollback failed:', err);
  process.exit(1);
});