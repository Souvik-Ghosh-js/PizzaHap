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
  console.log('🚀 Running v8 migrations (Location + Size combined pricing)...');

  // 1. CrustLocationSizePricing
  if (!await tableExists(pool, 'CrustLocationSizePricing')) {
    await pool.execute(`
      CREATE TABLE CrustLocationSizePricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        crust_id INT NOT NULL,
        location_id INT NOT NULL,
        size_code VARCHAR(10) NOT NULL,
        extra_price DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_crust_loc_size (crust_id, location_id, size_code),
        FOREIGN KEY (crust_id) REFERENCES CrustTypes(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    CrustLocationSizePricing table created');
  }

  // 2. ToppingLocationSizePricing
  if (!await tableExists(pool, 'ToppingLocationSizePricing')) {
    await pool.execute(`
      CREATE TABLE ToppingLocationSizePricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        topping_id INT NOT NULL,
        location_id INT NOT NULL,
        size_code VARCHAR(10) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_topping_loc_size (topping_id, location_id, size_code),
        FOREIGN KEY (topping_id) REFERENCES Toppings(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    ToppingLocationSizePricing table created');
  }

  console.log('\n✅ v8 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
