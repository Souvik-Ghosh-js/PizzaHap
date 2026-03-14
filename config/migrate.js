require('dotenv').config();
const { getPool } = require('./db');

const migrate = async () => {
  const pool = getPool();
  console.log('🚀 Running migrations...');

  const tables = [
    [`CREATE TABLE IF NOT EXISTS Locations (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, address VARCHAR(255) NOT NULL,
      city VARCHAR(100) NOT NULL, latitude DECIMAL(10,8) NOT NULL, longitude DECIMAL(11,8) NOT NULL,
      phone VARCHAR(20), email VARCHAR(100), is_active TINYINT(1) DEFAULT 1,
      opening_time TIME DEFAULT '10:00:00', closing_time TIME DEFAULT '23:00:00',
      created_at DATETIME DEFAULT NOW())`],
    [`CREATE TABLE IF NOT EXISTS Users (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(150) UNIQUE,
      mobile VARCHAR(15) NOT NULL, password_hash VARCHAR(255), profile_picture VARCHAR(500),
      is_verified TINYINT(1) DEFAULT 0, is_active TINYINT(1) DEFAULT 1, is_blocked TINYINT(1) DEFAULT 0,
      google_id VARCHAR(255), preferred_location_id INT, address VARCHAR(500),
      latitude DECIMAL(10,8), longitude DECIMAL(11,8),
      created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW(), last_login DATETIME,
      FOREIGN KEY (preferred_location_id) REFERENCES Locations(id))`],
    [`CREATE TABLE IF NOT EXISTS OtpTokens (
      id INT AUTO_INCREMENT PRIMARY KEY, identifier VARCHAR(150) NOT NULL, otp VARCHAR(6) NOT NULL,
      type VARCHAR(20) NOT NULL, expires_at DATETIME NOT NULL, is_used TINYINT(1) DEFAULT 0,
      attempts INT DEFAULT 0, created_at DATETIME DEFAULT NOW())`],
    [`CREATE TABLE IF NOT EXISTS RefreshTokens (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, token VARCHAR(500) NOT NULL,
      expires_at DATETIME NOT NULL, created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE)`],
    [`CREATE TABLE IF NOT EXISTS Categories (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, description VARCHAR(500),
      image_url VARCHAR(500), sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT NOW())`],
    [`CREATE TABLE IF NOT EXISTS Products (
      id INT AUTO_INCREMENT PRIMARY KEY, category_id INT, name VARCHAR(150) NOT NULL,
      description VARCHAR(1000), image_url VARCHAR(500), is_veg TINYINT(1) DEFAULT 1,
      is_available TINYINT(1) DEFAULT 1, is_featured TINYINT(1) DEFAULT 0,
      base_price DECIMAL(10,2) NOT NULL, sort_order INT DEFAULT 0,
      created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (category_id) REFERENCES Categories(id))`],
    [`CREATE TABLE IF NOT EXISTS ProductSizes (
      id INT AUTO_INCREMENT PRIMARY KEY, product_id INT, size_name VARCHAR(50) NOT NULL,
      size_code VARCHAR(10) NOT NULL, price DECIMAL(10,2) NOT NULL, is_available TINYINT(1) DEFAULT 1,
      FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE CASCADE)`],
    [`CREATE TABLE IF NOT EXISTS CrustTypes (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, extra_price DECIMAL(10,2) DEFAULT 0.00,
      is_available TINYINT(1) DEFAULT 1, sort_order INT DEFAULT 0)`],
    [`CREATE TABLE IF NOT EXISTS Toppings (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, price DECIMAL(10,2) NOT NULL,
      is_veg TINYINT(1) DEFAULT 1, is_available TINYINT(1) DEFAULT 1, image_url VARCHAR(500), sort_order INT DEFAULT 0)`],
    [`CREATE TABLE IF NOT EXISTS Coupons (
      id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(50) UNIQUE NOT NULL, description VARCHAR(500),
      discount_type ENUM('percentage','flat') NOT NULL, discount_value DECIMAL(10,2) NOT NULL,
      min_order_value DECIMAL(10,2) DEFAULT 0, max_discount DECIMAL(10,2), usage_limit INT,
      used_count INT DEFAULT 0, per_user_limit INT DEFAULT 1,
      valid_from DATETIME NOT NULL, valid_until DATETIME NOT NULL, is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT NOW())`],
    [`CREATE TABLE IF NOT EXISTS UserCouponUsage (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, coupon_id INT, order_id INT,
      used_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id), FOREIGN KEY (coupon_id) REFERENCES Coupons(id))`],
    [`CREATE TABLE IF NOT EXISTS Orders (
      id INT AUTO_INCREMENT PRIMARY KEY, order_number VARCHAR(20) UNIQUE NOT NULL,
      user_id INT, location_id INT,
      status ENUM('pending','confirmed','preparing','out_for_delivery','delivered','cancelled','refund_requested','refunded') DEFAULT 'pending',
      delivery_type ENUM('delivery','pickup') DEFAULT 'delivery',
      delivery_address VARCHAR(500), delivery_latitude DECIMAL(10,8), delivery_longitude DECIMAL(11,8),
      subtotal DECIMAL(10,2) NOT NULL, discount_amount DECIMAL(10,2) DEFAULT 0,
      delivery_fee DECIMAL(10,2) DEFAULT 0, tax_amount DECIMAL(10,2) DEFAULT 0,
      total_amount DECIMAL(10,2) NOT NULL, coupon_id INT, special_instructions VARCHAR(500),
      estimated_delivery_time INT,
      payment_status ENUM('pending','paid','failed','refunded') DEFAULT 'pending',
      cancellation_reason VARCHAR(500), cancellation_time DATETIME, cancelled_by VARCHAR(20),
      created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id), FOREIGN KEY (location_id) REFERENCES Locations(id))`],
    [`CREATE TABLE IF NOT EXISTS OrderItems (
      id INT AUTO_INCREMENT PRIMARY KEY, order_id INT, product_id INT,
      product_name VARCHAR(150) NOT NULL, size_id INT, size_name VARCHAR(50),
      crust_id INT, crust_name VARCHAR(100), quantity INT NOT NULL DEFAULT 1,
      unit_price DECIMAL(10,2) NOT NULL, total_price DECIMAL(10,2) NOT NULL, special_instructions VARCHAR(500),
      FOREIGN KEY (order_id) REFERENCES Orders(id) ON DELETE CASCADE)`],
    [`CREATE TABLE IF NOT EXISTS OrderItemToppings (
      id INT AUTO_INCREMENT PRIMARY KEY, order_item_id INT, topping_id INT,
      topping_name VARCHAR(100) NOT NULL, price DECIMAL(10,2) NOT NULL,
      FOREIGN KEY (order_item_id) REFERENCES OrderItems(id) ON DELETE CASCADE)`],
    [`CREATE TABLE IF NOT EXISTS OrderStatusHistory (
      id INT AUTO_INCREMENT PRIMARY KEY, order_id INT, status VARCHAR(30) NOT NULL,
      note VARCHAR(500), changed_by INT, changed_by_role VARCHAR(20), created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (order_id) REFERENCES Orders(id))`],
    [`CREATE TABLE IF NOT EXISTS Payments (
      id INT AUTO_INCREMENT PRIMARY KEY, order_id INT, gateway_order_id VARCHAR(100),
      gateway_payment_id VARCHAR(100), gateway_signature VARCHAR(500),
      payment_method ENUM('upi','credit_card','debit_card','net_banking','cash_on_delivery','wallet') NOT NULL,
      amount DECIMAL(10,2) NOT NULL, currency VARCHAR(5) DEFAULT 'INR',
      status ENUM('pending','captured','failed','refunded') DEFAULT 'pending',
      gateway_response TEXT, created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (order_id) REFERENCES Orders(id))`],
    [`CREATE TABLE IF NOT EXISTS Refunds (
      id INT AUTO_INCREMENT PRIMARY KEY, order_id INT, payment_id INT,
      amount DECIMAL(10,2) NOT NULL, reason VARCHAR(500) NOT NULL,
      status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
      requested_by INT, processed_by INT,
      requested_at DATETIME DEFAULT NOW(), processed_at DATETIME, notes VARCHAR(500),
      FOREIGN KEY (order_id) REFERENCES Orders(id), FOREIGN KEY (payment_id) REFERENCES Payments(id))`],
    [`CREATE TABLE IF NOT EXISTS Ratings (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, order_id INT, product_id INT,
      rating INT NOT NULL CHECK(rating BETWEEN 1 AND 5), review VARCHAR(1000),
      is_approved TINYINT(1) DEFAULT 1, created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id))`],
    [`CREATE TABLE IF NOT EXISTS Notifications (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, title VARCHAR(200) NOT NULL,
      message VARCHAR(1000) NOT NULL, type ENUM('order','promo','system','refund') NOT NULL,
      is_read TINYINT(1) DEFAULT 0, data JSON, created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id))`],
    [`CREATE TABLE IF NOT EXISTS SupportTickets (
      id INT AUTO_INCREMENT PRIMARY KEY, ticket_number VARCHAR(20) UNIQUE NOT NULL,
      user_id INT, order_id INT, subject VARCHAR(200) NOT NULL,
      category ENUM('order_issue','payment','refund','delivery','other') NOT NULL,
      priority ENUM('low','medium','high','urgent') DEFAULT 'medium',
      status ENUM('open','in_progress','resolved','closed') DEFAULT 'open',
      assigned_to INT, created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW(), resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES Users(id))`],
    [`CREATE TABLE IF NOT EXISTS SupportMessages (
      id INT AUTO_INCREMENT PRIMARY KEY, ticket_id INT, sender_id INT NOT NULL,
      sender_role ENUM('user','admin','support') NOT NULL, message VARCHAR(2000) NOT NULL,
      attachment_url VARCHAR(500), is_read TINYINT(1) DEFAULT 0, created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (ticket_id) REFERENCES SupportTickets(id) ON DELETE CASCADE)`],
    [`CREATE TABLE IF NOT EXISTS Admins (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('super_admin','admin','support','kitchen') DEFAULT 'admin',
      location_id INT, is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT NOW(), last_login DATETIME)`],
    [`CREATE TABLE IF NOT EXISTS Invoices (
      id INT AUTO_INCREMENT PRIMARY KEY, invoice_number VARCHAR(30) UNIQUE NOT NULL,
      order_id INT, user_id INT, subtotal DECIMAL(10,2) NOT NULL,
      discount_amount DECIMAL(10,2) DEFAULT 0, delivery_fee DECIMAL(10,2) DEFAULT 0,
      cgst DECIMAL(10,2) DEFAULT 0, sgst DECIMAL(10,2) DEFAULT 0,
      total_amount DECIMAL(10,2) NOT NULL, invoice_url VARCHAR(500), created_at DATETIME DEFAULT NOW())`],
  ];

  for (const [sql] of tables) {
    await pool.execute(sql);
  }

  console.log('✅ All tables created successfully!');
  process.exit(0);
};

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});

// ─── Additional migration: ProductLocationAvailability ──────────
// Run this separately if the table doesn't exist
const migrateExtra = async () => {
  const { getPool } = require('./db');
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
  console.log('✅ ProductLocationAvailability table created/verified');
};
