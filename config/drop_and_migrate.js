require('dotenv').config({ path: '../.env' });
const { getPool } = require('./db');
const bcrypt = require('bcryptjs');

const run = async () => {
  const pool = await getPool();
  const conn = await pool.getConnection();

  // ─── STEP 1: DROP ALL TABLES ──────────────────────────────────────
  console.log('🗑️  Dropping all tables...');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');

  const [tables] = await conn.execute(
    `SELECT TABLE_NAME 
     FROM information_schema.tables 
     WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
    [process.env.DB_NAME]
  );

  for (const row of tables) {
    const tbl = row.TABLE_NAME;          // ← uppercase TABLE_NAME is correct
    await conn.execute(`DROP TABLE IF EXISTS \`${tbl}\``);
    console.log(`   Dropped: ${tbl}`);
  }

  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  console.log('✅ All tables dropped.\n');

  // ─── STEP 2: CREATE TABLES ────────────────────────────────────────
  console.log('🏗️  Creating tables...');

  const ddl = [
    `CREATE TABLE Locations (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      name         VARCHAR(100) NOT NULL,
      address      VARCHAR(300) NOT NULL,
      latitude     DECIMAL(10,7) NOT NULL,
      longitude    DECIMAL(10,7) NOT NULL,
      phone        VARCHAR(20),
      opening_time TIME DEFAULT '09:00:00',
      closing_time TIME DEFAULT '23:00:00',
      is_active    TINYINT(1) DEFAULT 1,
      created_at   DATETIME DEFAULT NOW()
    )`,

    `CREATE TABLE Admins (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(100) NOT NULL,
      email         VARCHAR(150) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role          ENUM('super_admin','admin','staff','kitchen') DEFAULT 'admin',
      location_id   INT,
      is_active     TINYINT(1) DEFAULT 1,
      created_at    DATETIME DEFAULT NOW(),
      last_login    DATETIME,
      FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE SET NULL
    )`,

    `CREATE TABLE Users (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      name                  VARCHAR(100) NOT NULL,
      email                 VARCHAR(150) UNIQUE NOT NULL,
      mobile                VARCHAR(20),
      profile_picture       VARCHAR(500),
      address               VARCHAR(500),
      latitude              DECIMAL(10,7),
      longitude             DECIMAL(10,7),
      preferred_location_id INT,
      is_verified           TINYINT(1) DEFAULT 1,
      is_active             TINYINT(1) DEFAULT 1,
      is_blocked            TINYINT(1) DEFAULT 0,
      created_at            DATETIME DEFAULT NOW(),
      last_login            DATETIME,
      FOREIGN KEY (preferred_location_id) REFERENCES Locations(id) ON DELETE SET NULL
    )`,

    `CREATE TABLE OtpTokens (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      identifier VARCHAR(150) NOT NULL,
      otp        VARCHAR(10) NOT NULL,
      type       ENUM('email_verification','password_reset') DEFAULT 'email_verification',
      attempts   INT DEFAULT 0,
      is_used    TINYINT(1) DEFAULT 0,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT NOW(),
      INDEX idx_identifier_type (identifier, type)
    )`,

    `CREATE TABLE RefreshTokens (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      token      VARCHAR(500) NOT NULL,
      expires_at DATETIME NOT NULL,
      is_revoked TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE Categories (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      description VARCHAR(500),
      image_url   VARCHAR(500),
      sort_order  INT DEFAULT 0,
      is_active   TINYINT(1) DEFAULT 1
    )`,

    `CREATE TABLE Products (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      category_id  INT NOT NULL,
      name         VARCHAR(150) NOT NULL,
      description  VARCHAR(1000),
      image_url    VARCHAR(500),
      base_price   DECIMAL(10,2) NOT NULL,
      is_veg       TINYINT(1) DEFAULT 1,
      is_featured  TINYINT(1) DEFAULT 0,
      is_available TINYINT(1) DEFAULT 1,
      sort_order   INT DEFAULT 0,
      created_at   DATETIME DEFAULT NOW(),
      updated_at   DATETIME DEFAULT NOW(),
      FOREIGN KEY (category_id) REFERENCES Categories(id)
    )`,

    `CREATE TABLE ProductLocationAvailability (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      product_id   INT NOT NULL,
      location_id  INT NOT NULL,
      is_available TINYINT(1) DEFAULT 1,
      updated_at   DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_prod_loc (product_id, location_id),
      FOREIGN KEY (product_id)  REFERENCES Products(id)  ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES Locations(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE ProductSizes (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      product_id   INT NOT NULL,
      size_name    VARCHAR(50) NOT NULL,
      size_code    VARCHAR(10),
      price        DECIMAL(10,2) NOT NULL,
      is_available TINYINT(1) DEFAULT 1,
      FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE CrustTypes (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      name         VARCHAR(100) NOT NULL,
      extra_price  DECIMAL(10,2) DEFAULT 0.00,
      is_available TINYINT(1) DEFAULT 1,
      sort_order   INT DEFAULT 0
    )`,

    `CREATE TABLE Toppings (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      name         VARCHAR(100) NOT NULL,
      price        DECIMAL(10,2) NOT NULL,
      is_veg       TINYINT(1) DEFAULT 1,
      is_available TINYINT(1) DEFAULT 1,
      sort_order   INT DEFAULT 0
    )`,

    `CREATE TABLE Coupons (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      code            VARCHAR(50) UNIQUE NOT NULL,
      description     VARCHAR(300),
      discount_type   ENUM('percentage','flat') NOT NULL,
      discount_value  DECIMAL(10,2) NOT NULL,
      min_order_value DECIMAL(10,2) DEFAULT 0,
      max_discount    DECIMAL(10,2),
      usage_limit     INT,
      per_user_limit  INT DEFAULT 1,
      used_count      INT DEFAULT 0,
      is_active       TINYINT(1) DEFAULT 1,
      valid_from      DATETIME NOT NULL,
      valid_until     DATETIME NOT NULL,
      created_at      DATETIME DEFAULT NOW()
    )`,

    `CREATE TABLE UserCouponUsage (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      user_id   INT NOT NULL,
      coupon_id INT NOT NULL,
      order_id  INT,
      used_at   DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id)   REFERENCES Users(id),
      FOREIGN KEY (coupon_id) REFERENCES Coupons(id)
    )`,

    `CREATE TABLE Orders (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      order_number         VARCHAR(30) UNIQUE NOT NULL,
      user_id              INT NOT NULL,
      location_id          INT NOT NULL,
      delivery_type        ENUM('delivery','pickup') DEFAULT 'delivery',
      delivery_address     VARCHAR(500),
      delivery_latitude    DECIMAL(10,7),
      delivery_longitude   DECIMAL(10,7),
      subtotal             DECIMAL(10,2) NOT NULL,
      discount_amount      DECIMAL(10,2) DEFAULT 0,
      delivery_fee         DECIMAL(10,2) DEFAULT 0,
      tax_amount           DECIMAL(10,2) DEFAULT 0,
      total_amount         DECIMAL(10,2) NOT NULL,
      coupon_id            INT,
      status               ENUM('pending','confirmed','preparing','out_for_delivery','delivered','cancelled','refund_requested') DEFAULT 'pending',
      payment_status       ENUM('pending','paid','failed','refunded') DEFAULT 'pending',
      special_instructions VARCHAR(500),
      cancellation_reason  VARCHAR(500),
      cancellation_time    DATETIME,
      cancelled_by         ENUM('user','admin'),
      created_at           DATETIME DEFAULT NOW(),
      updated_at           DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id)     REFERENCES Users(id),
      FOREIGN KEY (location_id) REFERENCES Locations(id),
      FOREIGN KEY (coupon_id)   REFERENCES Coupons(id)
    )`,

    `CREATE TABLE OrderItems (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      order_id             INT NOT NULL,
      product_id           INT,
      product_name         VARCHAR(150) NOT NULL,
      size_id              INT,
      size_name            VARCHAR(50),
      crust_id             INT,
      crust_name           VARCHAR(100),
      quantity             INT NOT NULL DEFAULT 1,
      unit_price           DECIMAL(10,2) NOT NULL,
      total_price          DECIMAL(10,2) NOT NULL,
      special_instructions VARCHAR(500),
      FOREIGN KEY (order_id) REFERENCES Orders(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE OrderItemToppings (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      order_item_id INT NOT NULL,
      topping_id    INT,
      topping_name  VARCHAR(100) NOT NULL,
      price         DECIMAL(10,2) NOT NULL,
      FOREIGN KEY (order_item_id) REFERENCES OrderItems(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE OrderStatusHistory (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      order_id        INT NOT NULL,
      status          VARCHAR(30) NOT NULL,
      note            VARCHAR(500),
      changed_by      INT,
      changed_by_role VARCHAR(20),
      created_at      DATETIME DEFAULT NOW(),
      FOREIGN KEY (order_id) REFERENCES Orders(id)
    )`,

    `CREATE TABLE Payments (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      order_id           INT NOT NULL,
      gateway_order_id   VARCHAR(100),
      gateway_payment_id VARCHAR(100),
      gateway_signature  VARCHAR(500),
      payment_method     ENUM('upi','credit_card','debit_card','net_banking','cash_on_delivery','wallet') NOT NULL,
      amount             DECIMAL(10,2) NOT NULL,
      currency           VARCHAR(5) DEFAULT 'INR',
      status             ENUM('pending','captured','failed','refunded') DEFAULT 'pending',
      gateway_response   TEXT,
      created_at         DATETIME DEFAULT NOW(),
      updated_at         DATETIME DEFAULT NOW(),
      FOREIGN KEY (order_id) REFERENCES Orders(id)
    )`,

    `CREATE TABLE Refunds (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      order_id     INT NOT NULL,
      payment_id   INT,
      amount       DECIMAL(10,2) NOT NULL,
      reason       VARCHAR(500) NOT NULL,
      status       ENUM('pending','processing','completed','failed') DEFAULT 'pending',
      requested_by INT,
      processed_by INT,
      requested_at DATETIME DEFAULT NOW(),
      processed_at DATETIME,
      notes        VARCHAR(500),
      FOREIGN KEY (order_id)   REFERENCES Orders(id),
      FOREIGN KEY (payment_id) REFERENCES Payments(id)
    )`,

    `CREATE TABLE Ratings (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      order_id    INT,
      product_id  INT NOT NULL,
      rating      INT NOT NULL CHECK(rating BETWEEN 1 AND 5),
      review      VARCHAR(1000),
      is_approved TINYINT(1) DEFAULT 1,
      created_at  DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id)
    )`,

    `CREATE TABLE Notifications (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      title      VARCHAR(200) NOT NULL,
      message    VARCHAR(1000) NOT NULL,
      type       ENUM('order','promo','system','refund') NOT NULL,
      is_read    TINYINT(1) DEFAULT 0,
      data       JSON,
      created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES Users(id)
    )`,

    `CREATE TABLE SupportTickets (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      ticket_number VARCHAR(20) UNIQUE NOT NULL,
      user_id       INT,
      order_id      INT,
      subject       VARCHAR(200) NOT NULL,
      category      ENUM('order_issue','payment','refund','delivery','other') NOT NULL,
      priority      ENUM('low','medium','high','urgent') DEFAULT 'medium',
      status        ENUM('open','in_progress','resolved','closed') DEFAULT 'open',
      assigned_to   INT,
      created_at    DATETIME DEFAULT NOW(),
      updated_at    DATETIME DEFAULT NOW(),
      resolved_at   DATETIME,
      FOREIGN KEY (user_id) REFERENCES Users(id)
    )`,

    `CREATE TABLE SupportMessages (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id      INT NOT NULL,
      sender_id      INT NOT NULL,
      sender_role    ENUM('user','admin','support') NOT NULL,
      message        VARCHAR(2000) NOT NULL,
      attachment_url VARCHAR(500),
      is_read        TINYINT(1) DEFAULT 0,
      created_at     DATETIME DEFAULT NOW(),
      FOREIGN KEY (ticket_id) REFERENCES SupportTickets(id) ON DELETE CASCADE
    )`,
  ];

  for (const sql of ddl) {
    const tableName = sql.match(/CREATE TABLE (\w+)/)?.[1];
    await conn.execute(sql);
    console.log(`   ✅ Created: ${tableName}`);
  }
  console.log('\n✅ All tables created.\n');

  conn.release();
  console.log('\n✅ All tables created.\n');
  process.exit(0);
};

run().catch(e => { console.error('❌', e); process.exit(1); });
