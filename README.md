# 🍕 GOBT Pizza Backend

Node.js + Express + MSSQL backend for the GOBT Pizza ordering platform.

## Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: Microsoft SQL Server (MSSQL)
- **Auth**: JWT + Gmail OTP
- **Payments**: Razorpay
- **Email**: Nodemailer (Gmail)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your DB credentials, Gmail, Razorpay keys

# 3. Run database migrations
npm run migrate

# 4. Seed initial data (locations, categories, sample pizzas, admin)
npm run seed

# 5. Start server
npm run dev       # development
npm start         # production
```

**Default admin login:** `admin@gobt.com` / `Admin@123`

---

## API Reference

Base URL: `http://localhost:5000/api`

All protected routes require: `Authorization: Bearer <token>`

---

### 🔐 Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/send-otp` | ❌ | Send OTP to email |
| POST | `/auth/register` | ❌ | Register with OTP + name + mobile |
| POST | `/auth/login` | ❌ | Login with email + OTP |
| POST | `/auth/refresh-token` | ❌ | Refresh access token |
| POST | `/auth/logout` | ❌ | Logout |
| GET | `/auth/me` | ✅ | Get profile |
| PUT | `/auth/profile` | ✅ | Update profile |

**Register body:**
```json
{ "name": "John", "email": "john@email.com", "mobile": "9876543210", "otp": "123456" }
```

---

### 📍 Locations (5 branches)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/locations` | ❌ | All locations (pass ?latitude=&longitude= to sort by distance) |
| GET | `/locations/nearest` | ❌ | Nearest branch to user |
| GET | `/locations/:id` | ❌ | Branch details |

---

### 🍕 Menu

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/menu/categories` | ❌ | All categories |
| GET | `/menu/products` | ❌ | All products (filter: ?category_id=&is_veg=&search=) |
| GET | `/menu/products/featured` | ❌ | Featured products |
| GET | `/menu/products/:id` | ❌ | Product detail (with sizes, crusts, toppings, reviews) |
| GET | `/menu/toppings` | ❌ | All toppings (?is_veg=true/false) |
| GET | `/menu/crusts` | ❌ | All crust types |

---

### 📦 Orders

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/orders/calculate` | ✅ | Price preview before placing |
| POST | `/orders` | ✅ | Place order |
| GET | `/orders` | ✅ | Order history (?status=&page=&limit=) |
| GET | `/orders/:id` | ✅ | Order detail with items + history |
| POST | `/orders/:id/cancel` | ✅ | Cancel order (within window) |
| POST | `/orders/:id/reorder` | ✅ | Get cart items from past order |

**Place order body:**
```json
{
  "location_id": 1,
  "delivery_type": "delivery",
  "delivery_address": "123 MG Road",
  "items": [
    {
      "product_id": 1,
      "size_id": 2,
      "crust_id": 1,
      "quantity": 1,
      "toppings": [1, 3],
      "special_instructions": "Extra spicy"
    }
  ],
  "coupon_code": "WELCOME50",
  "payment_method": "upi"
}
```

---

### 💳 Payments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/payments/create-order` | ✅ | Create Razorpay order |
| POST | `/payments/verify` | ✅ | Verify payment signature |
| POST | `/payments/razorpay-webhook` | ❌ | Razorpay webhook handler |

**Payment flow:**
1. Place order → get `order_id`
2. `POST /payments/create-order` → get `razorpay_order_id`
3. Open Razorpay checkout in Flutter
4. On success → `POST /payments/verify`

---

### 💸 Refunds

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/refunds/request` | ✅ | Request refund for order |
| GET | `/refunds/my-refunds` | ✅ | My refund history |

**Refund policy:** Auto-refund to original payment method within 3-5 business days.

---

### 🎟 Coupons

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/coupons` | ✅ | Active coupons |
| POST | `/coupons/validate` | ✅ | Validate coupon + get discount |

---

### 🌟 Ratings

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/ratings` | ✅ | Submit rating (only for delivered orders) |
| GET | `/ratings/product/:id` | ❌ | Product ratings |

---

### 🔔 Notifications

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/notifications` | ✅ | Get notifications + unread count |
| PUT | `/notifications/read-all` | ✅ | Mark all read |
| PUT | `/notifications/:id/read` | ✅ | Mark one read |

---

### 🎧 Customer Support

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/support/tickets` | ✅ | Create ticket |
| GET | `/support/tickets` | ✅ | My tickets |
| GET | `/support/tickets/:id` | ✅ | Ticket + messages |
| POST | `/support/tickets/:id/reply` | ✅ | Reply to ticket |

---

### 🛠 Admin Panel

All admin routes require admin JWT. Role: `super_admin`, `admin`, `support`, `kitchen`

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| POST | `/admin/auth/login` | — | Admin login (password-based) |
| GET | `/admin/dashboard` | Any | Stats overview |
| GET | `/admin/dashboard/reports` | Any | Revenue reports (?period=daily/weekly/monthly) |
| GET | `/admin/orders` | Any | All orders (?status=&location_id=) |
| PUT | `/admin/orders/:id/status` | Any | Update order status |
| GET | `/admin/orders/:id/invoice` | Any | Invoice data |
| GET | `/admin/users` | Any | All users |
| PUT | `/admin/users/:id/block` | admin+ | Block/unblock user |
| POST | `/admin/menu/products` | admin+ | Add product |
| PUT | `/admin/menu/products/:id` | admin+ | Edit product |
| DELETE | `/admin/menu/products/:id` | admin+ | Remove product |
| POST | `/admin/coupons` | admin+ | Create coupon |
| GET | `/admin/refunds` | Any | All refunds |
| POST | `/admin/refunds/:id/process` | admin+ | Approve/reject refund |
| GET | `/admin/support/tickets` | Any | All tickets |
| POST | `/admin/support/tickets/:id/reply` | Any | Admin reply |

---

## Order Status Flow

```
pending → confirmed → preparing → out_for_delivery → delivered
     ↘        ↘           ↘
        cancelled (by user or admin within window)
```

## Database Tables

Users, OtpTokens, RefreshTokens, Locations, Categories, Products, ProductSizes, CrustTypes, Toppings, Coupons, UserCouponUsage, Orders, OrderItems, OrderItemToppings, OrderStatusHistory, Payments, Refunds, Ratings, Notifications, SupportTickets, SupportMessages, Admins, Invoices
