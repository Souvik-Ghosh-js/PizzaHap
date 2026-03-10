require('dotenv').config();
const { getPool } = require('./db');
const bcrypt = require('bcryptjs');

const seed = async () => {
  const pool = getPool();
  console.log('🌱 Seeding database...');

  const locations = [
    { name: 'GOBT Central', address: '12 MG Road, Bengaluru', city: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
    { name: 'GOBT Koramangala', address: '5th Block, Koramangala, Bengaluru', city: 'Bengaluru', lat: 12.9352, lng: 77.6245 },
    { name: 'GOBT Whitefield', address: 'ITPL Main Road, Whitefield, Bengaluru', city: 'Bengaluru', lat: 12.9698, lng: 77.7499 },
    { name: 'GOBT Indiranagar', address: '100 Feet Road, Indiranagar, Bengaluru', city: 'Bengaluru', lat: 12.9783, lng: 77.6408 },
    { name: 'GOBT Jayanagar', address: '4th Block, Jayanagar, Bengaluru', city: 'Bengaluru', lat: 12.9279, lng: 77.5824 },
  ];
  for (const loc of locations) {
    await pool.execute(
      `INSERT INTO Locations (name, address, city, latitude, longitude) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM Locations WHERE name = ?)`,
      [loc.name, loc.address, loc.city, loc.lat, loc.lng, loc.name]
    );
  }

  const categories = ['Veg Pizzas', 'Non-Veg Pizzas', 'Combos', 'Sides', 'Beverages', 'Desserts'];
  for (let i = 0; i < categories.length; i++) {
    await pool.execute(
      `INSERT INTO Categories (name, sort_order) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM Categories WHERE name = ?)`,
      [categories[i], i, categories[i]]
    );
  }

  const crusts = [
    { name: 'Classic Hand Tossed', extra: 0 }, { name: 'Thin & Crispy', extra: 0 },
    { name: 'Cheese Burst', extra: 80 }, { name: 'Wheat Thin Crust', extra: 30 },
    { name: 'Fresh Pan Pizza', extra: 50 },
  ];
  for (const crust of crusts) {
    await pool.execute(
      `INSERT INTO CrustTypes (name, extra_price) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM CrustTypes WHERE name = ?)`,
      [crust.name, crust.extra, crust.name]
    );
  }

  const toppings = [
    { name: 'Extra Cheese', price: 50, is_veg: 1 }, { name: 'Jalapenos', price: 30, is_veg: 1 },
    { name: 'Black Olives', price: 30, is_veg: 1 }, { name: 'Mushrooms', price: 40, is_veg: 1 },
    { name: 'Capsicum', price: 25, is_veg: 1 }, { name: 'Onion', price: 20, is_veg: 1 },
    { name: 'Paneer', price: 60, is_veg: 1 }, { name: 'Chicken Tikka', price: 80, is_veg: 0 },
    { name: 'Pepperoni', price: 90, is_veg: 0 }, { name: 'Grilled Chicken', price: 75, is_veg: 0 },
  ];
  for (const t of toppings) {
    await pool.execute(
      `INSERT INTO Toppings (name, price, is_veg) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM Toppings WHERE name = ?)`,
      [t.name, t.price, t.is_veg, t.name]
    );
  }

  const [vegCat] = await pool.execute(`SELECT id FROM Categories WHERE name = 'Veg Pizzas'`);
  const [nonVegCat] = await pool.execute(`SELECT id FROM Categories WHERE name = 'Non-Veg Pizzas'`);
  const vegCatId = vegCat[0]?.id;
  const nonVegCatId = nonVegCat[0]?.id;

  const products = [
    { name: 'Margherita', desc: 'Classic delight with 100% real mozzarella cheese', base_price: 199, is_veg: 1, cat: vegCatId },
    { name: 'Veggie Paradise', desc: 'Black olive, capsicum, red paprika, tomato', base_price: 249, is_veg: 1, cat: vegCatId },
    { name: 'Paneer Makhani', desc: 'Golden corn, paneer, makhani sauce', base_price: 279, is_veg: 1, cat: vegCatId },
    { name: 'Chicken Tikka', desc: 'Freshly made chicken tikka, onions, capsicum', base_price: 329, is_veg: 0, cat: nonVegCatId },
    { name: 'Pepperoni Feast', desc: 'Extra pepperoni, extra cheese, spicy sauce', base_price: 349, is_veg: 0, cat: nonVegCatId },
  ];
  for (const p of products) {
    const [existing] = await pool.execute(`SELECT id FROM Products WHERE name = ?`, [p.name]);
    if (!existing.length) {
      const [res] = await pool.execute(
        `INSERT INTO Products (category_id, name, description, base_price, is_veg) VALUES (?,?,?,?,?)`,
        [p.cat, p.name, p.desc, p.base_price, p.is_veg]
      );
      const productId = res.insertId;
      const sizes = [
        { name: 'Small (7")', code: 'S', price: p.base_price },
        { name: 'Medium (10")', code: 'M', price: p.base_price + 80 },
        { name: 'Large (12")', code: 'L', price: p.base_price + 160 },
      ];
      for (const s of sizes) {
        await pool.execute(`INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?)`, [productId, s.name, s.code, s.price]);
      }
    }
  }

  const passwordHash = await bcrypt.hash('Admin@123', 12);
  await pool.execute(
    `INSERT INTO Admins (name, email, password_hash, role) SELECT ?,?,?,'super_admin' WHERE NOT EXISTS (SELECT 1 FROM Admins WHERE email = 'admin@gobt.com')`,
    ['Super Admin', 'admin@gobt.com', passwordHash]
  );

  await pool.execute(
    `INSERT INTO Coupons (code, description, discount_type, discount_value, min_order_value, max_discount, valid_from, valid_until)
     SELECT 'WELCOME50','Welcome offer - 50% off on first order','percentage',50,200,150,NOW(),DATE_ADD(NOW(), INTERVAL 1 YEAR)
     WHERE NOT EXISTS (SELECT 1 FROM Coupons WHERE code = 'WELCOME50')`
  );
  await pool.execute(
    `INSERT INTO Coupons (code, description, discount_type, discount_value, min_order_value, valid_from, valid_until)
     SELECT 'FLAT100','Flat Rs.100 off on orders above Rs.500','flat',100,500,NOW(),DATE_ADD(NOW(), INTERVAL 1 YEAR)
     WHERE NOT EXISTS (SELECT 1 FROM Coupons WHERE code = 'FLAT100')`
  );

  console.log('✅ Seed complete!');
  process.exit(0);
};

seed().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
