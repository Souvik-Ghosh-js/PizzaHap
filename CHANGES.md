# Changelog

## Latest Fixes

### 1. No Tax System
- Removed all tax calculations (`tax_amount` is always `0`)
- `total_amount = subtotal - discount - coins_discount + delivery_fee`
- Invoice no longer shows CGST/SGST lines
- Affects: `orderController.js`, `adminController.js` (in-house orders), `miscController.js`

### 2. Fixed `total_amount` Saving as 0.00
**Root cause**: The `Orders` table was missing `payment_method` and `coins_redeemed` columns,
causing the `INSERT` to fail silently and default all DECIMAL fields to `0.00`.
**Fix**: `drop_and_migrate.js` now correctly defines all columns including `payment_method`,
`coins_redeemed`, `coins_earned`. Run the migration to apply.

### 3. PayU — Full Flow Fixed
- Fixed reverse hash string order for payment verification
- `verifyPayment` now accepts both PayU field names (`txnid`, `mihpayid`, `hash`) and
  legacy Razorpay aliases (`razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`)
- Webhook handles `cancel`/`cancelled` statuses in addition to `failure`/`failed`
- `initiatePayURefund` uses the correct hash: `key|command|var1|var2|var3|salt`
- Refund controller wraps PayU call in try/catch and returns a clean error if it fails

### 4. Toppings / Crust Per Category
- Added `has_toppings` (0/1) and `has_crust` (0/1) flags to `Categories` table
- `getProductById` only fetches toppings/crusts if the category flag is enabled
- Product list endpoints return `has_toppings` and `has_crust` so the frontend knows
  whether to show the selector
- Seeded: Pizzas → `has_toppings=1, has_crust=1`; all other categories → both `0`
- Admin can toggle these flags when creating or updating a category

### 5. Admin Can Add/Edit Categories
New admin endpoints:
- `GET    /api/admin/menu/categories`       — list all categories
- `POST   /api/admin/menu/categories`       — create category (`name`, `description`, `sort_order`, `has_toppings`, `has_crust`)
- `PUT    /api/admin/menu/categories/:id`   — update category
- `POST   /api/admin/menu/categories/:id/image` — upload category image

### 6. Admin Can Add/Edit Crust Types
New admin endpoints:
- `GET    /api/admin/menu/crusts`      — list
- `POST   /api/admin/menu/crusts`      — create (`name`, `extra_price`, `sort_order`)
- `PUT    /api/admin/menu/crusts/:id`  — update
- `DELETE /api/admin/menu/crusts/:id`  — disable

### 7. Admin Can Add/Edit Product Sizes
New admin endpoints:
- `GET    /api/admin/menu/products/:id/sizes`            — list sizes for a product
- `POST   /api/admin/menu/products/:id/sizes`            — add size
- `PUT    /api/admin/menu/products/:id/sizes/:sizeId`    — update size
- `DELETE /api/admin/menu/products/:id/sizes/:sizeId`    — delete size

### 8. In-House Orders Fixed
- No longer applies tax
- In-house orders are **auto-confirmed** immediately
- Cash-on-delivery in-house orders are **auto-marked as paid** immediately (no manual step)
- `adminPlaceOrder` correctly passes all required columns to the `Orders` INSERT

### 9. Schema — New Tables Added
- `UserCoins` — wallet balances (was referenced in code but table missing)
- `CoinTransactions` — coin history
- `AdminNotifications` — admin notification feed
- `OrderFeedback` — order-level feedback
- `city` column added to `Locations`

---

## Migration Instructions

```bash
# 1. Drop all existing tables and recreate with correct schema
cd config
node drop_and_migrate.js

# 2. Seed all data (locations, admins, categories, products, toppings, coupons)
node seed.js
```

## Admin Credentials (after seed)
| Email | Password | Role | Location |
|---|---|---|---|
| superadmin@pizzahap.com | Super@123 | super_admin | All |
| admin.cp@pizzahap.com | Admin@123 | admin | Connaught Place |
| admin.bandra@pizzahap.com | Admin@123 | admin | Bandra West |
| admin.blr@pizzahap.com | Admin@123 | admin | Koramangala |
| admin.kol@pizzahap.com | Admin@123 | admin | Salt Lake |
