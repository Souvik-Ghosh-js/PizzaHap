require('dotenv').config();
const { getPool } = require('./db');

const tableExists = async (pool, table) => {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return rows[0].cnt > 0;
};

const migrate = async () => {
  const pool = getPool();
  console.log('🚀 Running v6 migrations (Payment Initiation)...');

  if (!await tableExists(pool, 'PaymentInitiations')) {
    await pool.execute(`
      CREATE TABLE PaymentInitiations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        txnid VARCHAR(100) NOT NULL UNIQUE,
        user_id INT NOT NULL,
        order_data TEXT NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES Users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    PaymentInitiations table created');
  } else {
    console.log('SKIP  PaymentInitiations already exists');
  }

  console.log('\n✅ v6 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
