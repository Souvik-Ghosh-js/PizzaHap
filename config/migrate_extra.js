require('dotenv').config();
const { getPool } = require('./db');

const migrateExtra = async () => {
  const pool = await getPool();
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ProductLocationAvailability (
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
  console.log('✅ ProductLocationAvailability table ready');
  process.exit(0);
};

migrateExtra().catch(err => { console.error(err); process.exit(1); });
