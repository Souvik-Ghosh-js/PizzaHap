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
  console.log('🚀 Running v7 migrations (Banners, Location Pricing, Geofences)...');

  // 1. Banners
  if (!await tableExists(pool, 'Banners')) {
    await pool.execute(`
      CREATE TABLE Banners (
        id INT AUTO_INCREMENT PRIMARY KEY,
        badge_text VARCHAR(50) NOT NULL,
        title_text VARCHAR(200) NOT NULL,
        gradient_start VARCHAR(9) NOT NULL DEFAULT '#991515',
        gradient_end VARCHAR(9) NOT NULL DEFAULT '#FF6B35',
        icon_name VARCHAR(50) NOT NULL DEFAULT 'local_offer',
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        valid_from DATETIME DEFAULT NULL,
        valid_until DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    Banners table created');
  } else {
    console.log('SKIP  Banners already exists');
  }

  // 2. ProductLocationPricing
  if (!await tableExists(pool, 'ProductLocationPricing')) {
    await pool.execute(`
      CREATE TABLE ProductLocationPricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_size_id INT NOT NULL,
        location_id INT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_size_location (product_size_id, location_id),
        FOREIGN KEY (product_size_id) REFERENCES ProductSizes(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    ProductLocationPricing table created');
  } else {
    console.log('SKIP  ProductLocationPricing already exists');
  }

  // 3. CrustLocationPricing
  if (!await tableExists(pool, 'CrustLocationPricing')) {
    await pool.execute(`
      CREATE TABLE CrustLocationPricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        crust_id INT NOT NULL,
        location_id INT NOT NULL,
        extra_price DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_crust_location (crust_id, location_id),
        FOREIGN KEY (crust_id) REFERENCES CrustTypes(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    CrustLocationPricing table created');
  } else {
    console.log('SKIP  CrustLocationPricing already exists');
  }

  // 4. ToppingLocationPricing
  if (!await tableExists(pool, 'ToppingLocationPricing')) {
    await pool.execute(`
      CREATE TABLE ToppingLocationPricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        topping_id INT NOT NULL,
        location_id INT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_topping_location (topping_id, location_id),
        FOREIGN KEY (topping_id) REFERENCES Toppings(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    ToppingLocationPricing table created');
  } else {
    console.log('SKIP  ToppingLocationPricing already exists');
  }

  // 5. LocationGeofences
  if (!await tableExists(pool, 'LocationGeofences')) {
    await pool.execute(`
      CREATE TABLE LocationGeofences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        location_id INT NOT NULL UNIQUE,
        polygon_coordinates JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('OK    LocationGeofences table created');
  } else {
    console.log('SKIP  LocationGeofences already exists');
  }

  console.log('\n✅ v7 migrations complete!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
