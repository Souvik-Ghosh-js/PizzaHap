# GOBT Pizza Backend — v2 Changes

## How to Deploy

```bash
# 1. Run the new migration (safe to run multiple times)
npm run migrate:v2

# 2. Restart the server
npm start
```

---

## 1. Admin: Missing APIs Added

### Toppings CRUD
| Method | Endpoint | Role |
|--------|----------|------|
| `GET`  | `/api/admin/menu/toppings` | Any admin |
| `POST` | `/api/admin/menu/toppings` | super_admin, admin |
| `PUT`  | `/api/admin/menu/toppings/:id` | super_admin, admin |
| `DELETE` | `/api/admin/menu/toppings/:id` | super_admin, admin |

**POST / PUT body:**
```json
{ "name": "Extra Cheese", "price": 30, "is_veg": true, "sort_order": 1 }
```

### Locations CRUD
| Method | Endpoint | Role |
|--------|----------|------|
| `GET`  | `/api/admin/locations` | Any admin |
| `POST` | `/api/admin/locations` | super_admin only |
| `PUT`  | `/api/admin/locations/:id` | super_admin only |

**POST body:**
```json
{
  "name": "Koramangala Branch",
  "address": "123 Main St",
  "city": "Bengaluru",
  "latitude": 12.9352,
  "longitude": 77.6245,
  "phone": "9999999999",
  "email": "koramangala@gobt.in",
  "opening_time": "10:00:00",
  "closing_time": "23:00:00"
}
```

### Coupons CRUD (GET + UPDATE added)
| Method | Endpoint | Role |
|--------|----------|------|
| `GET`  | `/api/admin/coupons` | Any admin |
| `POST` | `/api/admin/coupons` | super_admin, admin |
| `PUT`  | `/api/admin/coupons/:id` | super_admin, admin |

### Order Detail View (with items)
```
GET /api/admin/orders/:id
```
Returns full order with: items + toppings, status history, payment info, customer details, feedback.

---

## 2. Admin: Payment Status Management

### Mark payment as paid / failed (for COD orders)
```
PUT /api/admin/orders/:id/payment-status
Body: { "payment_status": "paid", "note": "Cash received" }
```
Valid values: `pending`, `paid`, `failed`, `refunded`

- When a COD order arrives, `payment_status` = `pending`
- Admin marks it `paid` once cash is received
- User receives a notification when payment status changes
- Orders now carry a `payment_method` field: `online` or `cash_on_delivery`

### Order list now filterable by payment status
```
GET /api/admin/orders?payment_status=pending&status=delivered
```

---

## 3. Admin: In-House Billing

### Place an order on behalf of a customer (or walk-in)
```
POST /api/admin/orders/inhouse
```
**Body:**
```json
{
  "user_id": 42,           // optional — null for walk-in
  "items": [
    { "product_id": 1, "size_id": 2, "crust_id": 1, "quantity": 2, "toppings": [3, 5] }
  ],
  "location_id": 1,        // auto-filled from admin's token if scoped
  "delivery_type": "pickup",
  "payment_method": "cash_on_delivery",
  "special_instructions": "Extra napkins"
}
```
- Admin's assigned `location_id` overrides the body value
- If `user_id` provided, user gets a notification
- Order appears in `GET /api/admin/orders` normally
- Admin can then update status + payment status as usual

---

## 4. Coins System (User-facing)

### How it works
- **Earn:** 1 coin per ₹10 spent → credited **only after delivery** (when admin marks order as `delivered`)
- **Redeem:** 1 coin = ₹1 discount at checkout
- **Revert:** coins are deducted if a refund is processed or order is cancelled

### New User APIs
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/orders/coins` | Get wallet balance + transaction history |

### Changes to `POST /api/orders/calculate`
New optional fields:
```json
{ "coins_to_redeem": 50 }
```
Response now includes:
```json
{
  "subtotal": 500,
  "discount_amount": 0,
  "coins_discount": 50,
  "delivery_fee": 0,
  "tax_amount": 22.5,
  "total_amount": 472.5,
  "available_coins": 120
}
```

### Changes to `POST /api/orders` (place order)
New optional fields:
```json
{
  "payment_method": "cash_on_delivery",
  "coins_to_redeem": 50
}
```
Response now includes:
```json
{
  "order_id": 101,
  "order_number": "GOBT-123456",
  "total_amount": 472.5,
  "coins_redeemed": 50,
  "coins_discount": 50
}
```

### Coins Notifications (automatic)
- ✅ "Coins Credited!" — after delivery
- ✅ "Coins Reverted" — after refund or cancellation

---

## 5. Notifications — Full System

### User notifications (existing + enhanced)
All order events now trigger notifications:
- Order placed → user + admins at that location
- Status changes (confirmed / preparing / out_for_delivery / delivered / cancelled) → user
- Payment status changes → user
- Refund requested / processed / rejected → user
- Coins credited / reverted → user

### Admin notifications (NEW)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/admin/notifications` | Get admin's notifications |
| `PUT`  | `/api/admin/notifications/:id/read` | Mark one read |
| `PUT`  | `/api/admin/notifications/read-all` | Mark all read |
| `POST` | `/api/admin/notifications/broadcast` | Send to users (super_admin/admin) |

**Location scoping:**
- A location-scoped admin sees notifications for their location only
- A `super_admin` (no location) sees all notifications

**Broadcast to users:**
```json
{
  "title": "Weekend Offer!",
  "message": "Get 20% off on all large pizzas this weekend.",
  "type": "promo",
  "user_ids": [1, 2, 3]   // optional — omit to broadcast to ALL users
}
```

---

## 6. User Feedback System

### Submit feedback on a delivered order
```
POST /api/orders/:id/feedback
```
**Body:**
```json
{
  "food_rating": 5,
  "delivery_rating": 4,
  "overall_rating": 5,
  "comment": "Pizza was amazing, delivery was quick!"
}
```
- Only allowed on `delivered` orders
- One feedback per order
- Feedback is visible in admin's order detail view (`GET /api/admin/orders/:id`)
- Existing per-product `POST /api/ratings` still works for individual item ratings

---

## 7. Structured Address Fields

### Updated `PUT /api/auth/profile` — now accepts split address
```json
{
  "address_house":   "Flat 4B, Sunrise Apartments",
  "address_town":    "Indiranagar",
  "address_state":   "Karnataka",
  "address_pincode": "560038"
}
```
Old `address` (single string) still works for backward compatibility.

### `GET /api/auth/me` — now returns
```json
{
  "address": "...",
  "address_house": "Flat 4B, Sunrise Apartments",
  "address_town": "Indiranagar",
  "address_state": "Karnataka",
  "address_pincode": "560038",
  "coin_balance": 120
}
```

### Admin user list also returns address fields + coin_balance per user

---

## 8. New Database Tables (migrate_v2.js)

| Table | Purpose |
|-------|---------|
| `UserCoins` | One row per user — current coin balance |
| `CoinTransactions` | Ledger of all earn / redeem / revert events |
| `OrderFeedback` | One feedback per delivered order |
| `AdminNotifications` | Location-scoped notifications for admins |

### Altered columns
| Table | Change |
|-------|--------|
| `Users` | Added: `address_house`, `address_town`, `address_state`, `address_pincode` |
| `Orders` | Added: `payment_method`, `coins_redeemed`, `coins_earned` |
| `Notifications` | ENUM extended with `'coins'` type |

---

## 9. Summary of All Admin Endpoints

```
Auth
  POST   /api/admin/auth/login

Dashboard
  GET    /api/admin/dashboard
  GET    /api/admin/dashboard/reports

Orders
  GET    /api/admin/orders                    (filter: status, payment_status, location_id)
  GET    /api/admin/orders/:id                (full detail with items + feedback)
  POST   /api/admin/orders/inhouse            (in-house billing)
  PUT    /api/admin/orders/:id/status         (status transition)
  PUT    /api/admin/orders/:id/payment-status (mark paid/failed/refunded)
  GET    /api/admin/orders/:id/invoice

Users
  GET    /api/admin/users
  PUT    /api/admin/users/:id/block

Menu
  GET    /api/admin/menu/products
  POST   /api/admin/menu/products
  PUT    /api/admin/menu/products/:id
  DELETE /api/admin/menu/products/:id
  POST   /api/admin/menu/products/:id/image
  PUT    /api/admin/menu/products/:id/location-availability
  GET    /api/admin/menu/products/:id/availability-matrix

Toppings (NEW)
  GET    /api/admin/menu/toppings
  POST   /api/admin/menu/toppings
  PUT    /api/admin/menu/toppings/:id
  DELETE /api/admin/menu/toppings/:id

Locations (NEW)
  GET    /api/admin/locations
  POST   /api/admin/locations              (super_admin only)
  PUT    /api/admin/locations/:id          (super_admin only)

Coupons (expanded)
  GET    /api/admin/coupons
  POST   /api/admin/coupons
  PUT    /api/admin/coupons/:id

Notifications (NEW)
  GET    /api/admin/notifications
  PUT    /api/admin/notifications/read-all
  PUT    /api/admin/notifications/:id/read
  POST   /api/admin/notifications/broadcast

Refunds
  GET    /api/admin/refunds
  POST   /api/admin/refunds/:id/process

Support
  GET    /api/admin/support/tickets
  POST   /api/admin/support/tickets/:id/reply
```
