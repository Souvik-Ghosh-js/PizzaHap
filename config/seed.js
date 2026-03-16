require('dotenv').config({ path: '../.env' });
const bcrypt = require('bcryptjs');
const { getPool } = require('./db');

const run = async () => {
  const pool = await getPool();
  const conn = await pool.getConnection();

  // ── Locations ──────────────────────────────────────────────────
  console.log('🌍 Seeding locations...');
  const locs = [
    ['PizzaHap - Connaught Place', 'Block A, Connaught Place, New Delhi', 'New Delhi',   28.6315, 77.2167, '+91-11-23456789'],
    ['PizzaHap - Bandra West',     '14 Turner Road, Bandra West, Mumbai',  'Mumbai',      19.0596, 72.8295, '+91-22-26440011'],
    ['PizzaHap - Koramangala',     '80 Feet Road, Koramangala, Bangalore', 'Bangalore',   12.9279, 77.6271, '+91-80-41234567'],
    ['PizzaHap - Salt Lake',       'Sector V, Salt Lake City, Kolkata',    'Kolkata',     22.5726, 88.4146, '+91-33-23210000'],
  ];
  const locIds = [];
  for (const [name, address, city, lat, lng, phone] of locs) {
    const [r] = await conn.execute(
      `INSERT INTO Locations (name, address, city, latitude, longitude, phone) VALUES (?,?,?,?,?,?)`,
      [name, address, city, lat, lng, phone]
    );
    locIds.push(r.insertId);
    console.log(`   ${name} → id=${r.insertId}`);
  }

  // ── Admins ─────────────────────────────────────────────────────
  console.log('\n👤 Seeding admins...');
  const hash      = await bcrypt.hash('Admin@123', 10);
  const superHash = await bcrypt.hash('Super@123', 10);
  const admins = [
    ['Super Admin',     'superadmin@pizzahap.com',  superHash, 'super_admin', null],
    ['CP Manager',      'admin.cp@pizzahap.com',    hash,      'admin',       locIds[0]],
    ['Bandra Manager',  'admin.bandra@pizzahap.com',hash,      'admin',       locIds[1]],
    ['Koramangala Mgr', 'admin.blr@pizzahap.com',   hash,      'admin',       locIds[2]],
    ['Salt Lake Mgr',   'admin.kol@pizzahap.com',   hash,      'admin',       locIds[3]],
  ];
  for (const [name, email, pwd, role, locId] of admins) {
    await conn.execute(
      `INSERT INTO Admins (name, email, password_hash, role, location_id) VALUES (?,?,?,?,?)`,
      [name, email, pwd, role, locId]
    );
    console.log(`   ${email} (${role})`);
  }

  // ── Categories ─────────────────────────────────────────────────
  // has_toppings=1 and has_crust=1 for Pizzas only
  console.log('\n📂 Seeding categories...');
  const cats = [
    ['Pizzas',           'Our signature hand-tossed pizzas',   1, 1, 1],
    ['Pasta',            'Italian pasta dishes',                2, 0, 0],
    ['Sides & Starters', 'Garlic bread, fries and more',       3, 0, 0],
    ['Desserts',         'Sweet endings',                       4, 0, 0],
    ['Beverages',        'Cold drinks, juices & more',          5, 0, 0],
  ];
  const catIds = [];
  for (const [name, desc, order, hasToppings, hasCrust] of cats) {
    const [r] = await conn.execute(
      `INSERT INTO Categories (name, description, sort_order, has_toppings, has_crust) VALUES (?,?,?,?,?)`,
      [name, desc, order, hasToppings, hasCrust]
    );
    catIds.push(r.insertId);
  }
  console.log(`   ${cats.length} categories created`);

  // ── Products ────────────────────────────────────────────────────
  console.log('\n🍕 Seeding products...');
  const products = [
    // Pizzas (cat index 0)
    { cat: 0, name: 'Margherita',        desc: 'Classic tomato sauce with fresh mozzarella',     price: 199, veg: 1, featured: 1 },
    { cat: 0, name: 'Farmhouse',         desc: 'Capsicum, onion, mushroom, tomato',               price: 249, veg: 1, featured: 1 },
    { cat: 0, name: 'Paneer Tikka',      desc: 'Spicy paneer with bell peppers and onions',       price: 279, veg: 1, featured: 0 },
    { cat: 0, name: 'BBQ Chicken',       desc: 'Smoky BBQ sauce with grilled chicken',            price: 299, veg: 0, featured: 1 },
    { cat: 0, name: 'Chicken Tikka',     desc: 'Tandoori chicken with onion and capsicum',        price: 289, veg: 0, featured: 0 },
    { cat: 0, name: 'Pepperoni',         desc: 'Classic pepperoni with mozzarella',               price: 319, veg: 0, featured: 1 },
    { cat: 0, name: 'Veggie Supreme',    desc: 'Loaded with seven vegetables',                    price: 259, veg: 1, featured: 0 },
    { cat: 0, name: 'Double Cheese',     desc: 'Extra mozzarella on classic sauce',               price: 269, veg: 1, featured: 0 },
    // Pasta (cat index 1)
    { cat: 1, name: 'Penne Arrabbiata', desc: 'Spicy tomato sauce with penne',                   price: 179, veg: 1, featured: 0 },
    { cat: 1, name: 'Chicken Alfredo',  desc: 'Creamy white sauce with grilled chicken',         price: 229, veg: 0, featured: 0 },
    { cat: 1, name: 'Mushroom Pesto',   desc: 'Basil pesto with mushrooms and parmesan',         price: 199, veg: 1, featured: 0 },
    // Sides (cat index 2)
    { cat: 2, name: 'Garlic Bread',      desc: 'Toasted bread with garlic butter',               price: 99,  veg: 1, featured: 0 },
    { cat: 2, name: 'Potato Wedges',     desc: 'Seasoned crispy wedges with dip',                price: 119, veg: 1, featured: 0 },
    { cat: 2, name: 'Mozzarella Sticks', desc: 'Crispy fried mozzarella with marinara',          price: 149, veg: 1, featured: 0 },
    // Desserts (cat index 3)
    { cat: 3, name: 'Choco Lava Cake',   desc: 'Warm chocolate cake with molten center',         price: 129, veg: 1, featured: 0 },
    { cat: 3, name: 'Tiramisu',          desc: 'Classic Italian coffee dessert',                 price: 149, veg: 1, featured: 0 },
    // Beverages (cat index 4)
    { cat: 4, name: 'Coke (300ml)',       desc: 'Ice cold Coca-Cola',                            price: 60,  veg: 1, featured: 0 },
    { cat: 4, name: 'Fresh Lime Soda',    desc: 'Sweet or salted',                               price: 79,  veg: 1, featured: 0 },
  ];
  const prodIds = [];
  for (const p of products) {
    const [r] = await conn.execute(
      `INSERT INTO Products (category_id, name, description, base_price, is_veg, is_featured) VALUES (?,?,?,?,?,?)`,
      [catIds[p.cat], p.name, p.desc, p.price, p.veg, p.featured]
    );
    prodIds.push(r.insertId);
  }
  console.log(`   ${products.length} products created`);

  // ── Product sizes ──────────────────────────────────────────────
  console.log('\n📏 Seeding product sizes...');
  const sizeDefs = [['Regular','REG',0],['Medium','MED',70],['Large','LG',130]];
  for (let i = 0; i < 8; i++) { // pizzas only get 3 sizes
    for (const [sname, scode, extra] of sizeDefs) {
      await conn.execute(
        `INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`,
        [prodIds[i], sname, scode, products[i].price + extra]
      );
    }
  }
  for (let i = 8; i < products.length; i++) { // non-pizza: single size
    await conn.execute(
      `INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`,
      [prodIds[i], 'Regular', 'REG', products[i].price]
    );
  }
  console.log('   Sizes seeded');

  // ── Crust types ────────────────────────────────────────────────
  console.log('\n🍞 Seeding crust types...');
  const crusts = [
    ['Classic Hand-Tossed', 0,  1],
    ['Thin & Crispy',       0,  2],
    ['Stuffed Crust',       50, 3],
    ['Cheese Burst',        80, 4],
  ];
  for (const [name, extra, order] of crusts) {
    await conn.execute(`INSERT INTO CrustTypes (name, extra_price, sort_order) VALUES (?,?,?)`, [name, extra, order]);
  }

  // ── Toppings ───────────────────────────────────────────────────
  console.log('\n🧅 Seeding toppings...');
  const toppings = [
    ['Extra Cheese',    30, 1, 1], ['Mushrooms',   25, 1, 2],
    ['Olives',          20, 1, 3], ['Jalapeños',   20, 1, 4],
    ['Onions',          15, 1, 5], ['Capsicum',    15, 1, 6],
    ['Chicken Chunks',  40, 0, 7], ['Pepperoni',   45, 0, 8],
  ];
  for (const [name, price, veg, order] of toppings) {
    await conn.execute(`INSERT INTO Toppings (name, price, is_veg, sort_order) VALUES (?,?,?,?)`, [name, price, veg, order]);
  }

  // ── Location-specific availability ────────────────────────────
  console.log('\n📍 Seeding location-specific availability...');
  const saltLakeId   = locIds[3];
  const bbqChickenId = prodIds[3];
  const pepperoniId  = prodIds[5];
  await conn.execute(
    `INSERT INTO ProductLocationAvailability (product_id, location_id, is_available) VALUES (?,?,0),(?,?,0)`,
    [bbqChickenId, saltLakeId, pepperoniId, saltLakeId]
  );
  console.log('   BBQ Chicken & Pepperoni marked unavailable at Salt Lake');

  // ── Coupons ────────────────────────────────────────────────────
  console.log('\n🎫 Seeding coupons...');
  const now  = new Date();
  const year = now.getFullYear() + 1;
  await conn.execute(
    `INSERT INTO Coupons (code, description, discount_type, discount_value, min_order_value, max_discount, valid_from, valid_until)
     VALUES (?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?)`,
    [
      'WELCOME50','Welcome! Get ₹50 off on your first order','flat',50,199,null,
        `${now.getFullYear()}-01-01 00:00:00`,`${year}-12-31 23:59:59`,
      'PIZZA20','20% off on orders above ₹400','percentage',20,400,150,
        `${now.getFullYear()}-01-01 00:00:00`,`${year}-12-31 23:59:59`,
    ]
  );

  conn.release();

  console.log('\n✅ Seed complete!\n');
  console.log('🔑 Admin credentials:');
  console.log('   Super Admin : superadmin@pizzahap.com  / Super@123  (all locations)');
  console.log('   CP Manager  : admin.cp@pizzahap.com    / Admin@123  (Connaught Place)');
  console.log('   Bandra      : admin.bandra@pizzahap.com/ Admin@123  (Bandra West)');
  console.log('   Bangalore   : admin.blr@pizzahap.com   / Admin@123  (Koramangala)');
  console.log('   Kolkata     : admin.kol@pizzahap.com   / Admin@123  (Salt Lake)\n');
  process.exit(0);
};

run().catch(e => { console.error('❌', e.message); process.exit(1); });
