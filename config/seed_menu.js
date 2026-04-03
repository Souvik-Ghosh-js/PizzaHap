const { getPool, query, transaction } = require('./db');

const cleanupAndSeed = async () => {
  console.log('🗑️  Beginning cleanup of existing data...');
  const pool = getPool();

  try {
    // 1. CLEAR TABLES
    await query('SET FOREIGN_KEY_CHECKS = 0');
    const tablesToClear = [
      'OrderStatusHistory', 'OrderItemToppings', 'OrderItems', 'UserCouponUsage', 'Payments', 'Refunds', 'Invoices', 'Orders',
      'ProductLocationAvailability', 'ProductLocationPricing', 'ProductSizes', 'Products', 'Categories',
      'CrustLocationPricing', 'ToppingLocationPricing', 'CrustSizePricing', 'ToppingSizePricing',
      'CrustLocationSizePricing', 'ToppingLocationSizePricing', 'CrustTypes', 'Toppings', 'Coupons', 'Banners',
      'Ratings', 'SupportMessages', 'SupportTickets'
    ];
    for (const t of tablesToClear) await query(`DELETE FROM ${t}`);
    await query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('✅ Tables cleared successfully');

    // 2. GET LOCATIONS (Assuming they exist, or fetch them)
    const locations = await query('SELECT id FROM Locations');
    if (locations.length === 0) {
      console.warn('⚠️ No locations found! Seeding will proceed but location pricing might miss targets.');
    }

    // 3. CATEGORIES
    const pizzaCatId = (await query("INSERT INTO Categories (name, description, sort_order, has_crust, has_toppings) VALUES ('Pizzas', 'Fresh baked pizzas', 1, 1, 1)")).insertId;
    const starterCatId = (await query("INSERT INTO Categories (name, description, sort_order, has_crust, has_toppings) VALUES ('Starters', 'Sides and snacks', 2, 0, 0)")).insertId;
    // Set crust/toppings flags via migration fix later if needed, but for now we know 'Pizza' category = 1
    // Actually the app logic uses category flags. We'll update categories later.

    // 4. CRUSTS
    const dBurstId = (await query("INSERT INTO CrustTypes (name, sort_order) VALUES ('Double Burst', 1)")).insertId;
    const cBurstId = (await query("INSERT INTO CrustTypes (name, sort_order) VALUES ('Cheese Burst', 2)")).insertId;

    // 5. TOPPINGS
    const vegTopId = (await query("INSERT INTO Toppings (name, is_veg, sort_order, price) VALUES ('Veg Topping', 1, 1, 30)")).insertId;
    const nvTopId = (await query("INSERT INTO Toppings (name, is_veg, sort_order, price) VALUES ('Non-Veg Topping', 0, 2, 40)")).insertId;
    const extraCheeseId = (await query("INSERT INTO Toppings (name, is_veg, sort_order, price) VALUES ('Extra Cheese', 1, 3, 40)")).insertId;

    // 6. BASE SIZE CODES
    const SIZES = [
      { code: 'regular', name: 'Regular' },
      { code: 'medium', name: 'Medium' },
      { code: 'large', name: 'Large' }
    ];

    // 7. CRUST/TOPPING SIZE PRICING (BASELINE)
    // Double Burst: S 90, M 130, L 150
    // Cheese Burst: S 70, M 100, L 130
    const crustPricing = [
      { id: dBurstId, s: 90, m: 130, l: 150 },
      { id: cBurstId, s: 70, m: 100, l: 130 }
    ];
    for (const p of crustPricing) {
      await query("INSERT INTO CrustSizePricing (crust_id, size_code, extra_price) VALUES (?,?,?), (?,?,?), (?,?,?)",
        [p.id, 'regular', p.s, p.id, 'medium', p.m, p.id, 'large', p.l]);
    }

    // Extra Toppings: Veg(30/40/60), NV(40/50/80), Cheese(40/50/80)
    const topPricing = [
      { id: vegTopId, s: 30, m: 40, l: 60 },
      { id: nvTopId, s: 40, m: 50, l: 80 },
      { id: extraCheeseId, s: 40, m: 50, l: 80 }
    ];
    for (const p of topPricing) {
      await query("INSERT INTO ToppingSizePricing (topping_id, size_code, price) VALUES (?,?,?), (?,?,?), (?,?,?)",
        [p.id, 'regular', p.s, p.id, 'medium', p.m, p.id, 'large', p.l]);
    }

    // 8. PIZZAS
    const pizzas = [
      // VEG 1
      { name: 'Cheese Tomato', s: 100, m: 199, l: 360, veg: 1 },
      { name: 'One Love Onion', s: 100, m: 199, l: 360, veg: 1 },
      { name: 'Double Cheese Margherita', s: 150, m: 299, l: 499, veg: 1 },
      { name: 'Just Veggie', s: 150, m: 299, l: 499, veg: 1 },
      { name: 'Veg Schezwan', s: 150, m: 299, l: 499, veg: 1 },
      { name: 'Cheese Corn', s: 150, m: 299, l: 499, veg: 1 },
      // VEG 2
      { name: '5 Star Deluxe', s: 199, m: 380, l: 540, veg: 1 },
      { name: 'Tandoori Paneer', s: 199, m: 380, l: 540, veg: 1 },
      { name: 'Tandoori Special', s: 199, m: 380, l: 540, veg: 1 },
      { name: 'Pizza Pasta', s: 199, m: 380, l: 540, veg: 1 },
      { name: 'Veg Deluxe', s: 199, m: 380, l: 540, veg: 1 },
      { name: 'Veg Mexicano', s: 199, m: 380, l: 540, veg: 1 },
      // VEG 3
      { name: 'Veg Extravaganza', s: 220, m: 400, l: 590, veg: 1 },
      { name: 'Veg Supremo', s: 220, m: 400, l: 590, veg: 1 },
      { name: 'Country Special', s: 220, m: 400, l: 590, veg: 1 },
      { name: 'Farm House', s: 220, m: 400, l: 590, veg: 1 },
      // NON VEG 1
      { name: 'Barbeque Chicken', s: 130, m: 240, l: 350, veg: 0 },
      { name: 'Cheese Onion Barbeque Chicken', s: 150, m: 200, l: 499, veg: 0 },
      { name: 'Chicken Love', s: 150, m: 200, l: 499, veg: 0 },
      // NON VEG 2
      { name: 'Chicken Tikka', s: 230, m: 350, l: 540, veg: 0 },
      { name: 'Non Veg Schezwan Pizza', s: 230, m: 350, l: 540, veg: 0 },
      { name: 'Non Veg Salsa Mexicano', s: 230, m: 350, l: 540, veg: 0 },
      // NON VEG 3
      { name: 'Haldwani Hit', s: 250, m: 430, l: 630, veg: 0 },
      { name: 'Non Veg Supremo Pizza', s: 250, m: 430, l: 630, veg: 0 },
      { name: '5 Star Deluxe Non Veg', s: 250, m: 430, l: 630, veg: 0 },
      { name: 'NH-87 Non Veg', s: 250, m: 430, l: 630, veg: 0 },
      { name: 'Tandoori City Hot', s: 250, m: 430, l: 630, veg: 0 },
      { name: 'Chicken Dominator', s: 250, m: 430, l: 630, veg: 0 },
      { name: 'Bollywood Spicy', s: 250, m: 430, l: 630, veg: 0 },
      { name: 'Special Tandoori Chicken', s: 250, m: 430, l: 630, veg: 0 },
    ];

    for (const p of pizzas) {
      const pid = (await query("INSERT INTO Products (category_id, name, base_price, is_veg) VALUES (?,?,?,?)",
        [pizzaCatId, p.name, p.s, p.veg])).insertId;
      await query("INSERT INTO ProductSizes (product_id, size_name, size_code, price) VALUES (?,?,?,?), (?,?,?,?), (?,?,?,?)",
        [pid, 'Regular', 'regular', p.s, pid, 'Medium', 'medium', p.m, pid, 'Large', 'large', p.l]);
    }

    // 9. STARTERS
    const starters = [
      { name: 'Garlic Bread Stick', p: 90 },
      { name: 'Cheesy Bites', p: 100 },
      { name: 'Stuffed Garlic Bread', p: 100 },
      { name: 'Non Veg Stuffed Garlic Bread', p: 120 },
      { name: 'Veg Schezwan Pocket', p: 70 },
      { name: 'Non Veg Schezwan Pocket', p: 80 },
      { name: 'Chicken Nuggets', p: 70 },
      { name: 'Veg Taco', p: 100 },
      { name: 'Non Veg Taco', p: 110 },
      { name: 'Veg Kathi Roll', p: 100 },
      { name: 'Non Veg Kathi Roll', p: 150 },
      { name: 'Veg Cheese Burger', p: 50 },
      { name: 'Non Veg Cheese Burger', p: 70 },
      { name: 'Premium Veg Burger', p: 90 },
      { name: 'Premium Non Veg Burger', p: 100 },
      { name: 'Veg Zingy Parcel', p: 40 },
      { name: 'Non Veg Zingy Parcel', p: 40 }
    ];

    for (const s of starters) {
      await query("INSERT INTO Products (category_id, name, base_price) VALUES (?,?,?)", [starterCatId, s.name, s.p]);
    }

    console.log('🍽️  Seeding complete! Menu data populated from image rates.');
    process.exit(0);

  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  }
};

cleanupAndSeed();
