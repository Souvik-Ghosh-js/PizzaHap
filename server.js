require('dotenv').config();
const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');
const { Server } = require('socket.io');

const { getPool }   = require('./config/db');
const { setIO }     = require('./config/socket');
const routes        = require('./routes');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');
const logger        = require('./utils/logger');
const { setupSwagger } = require('./swagger');

const app  = express();
const server = http.createServer(app);

// ─── SOCKET.IO ──────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: '*' } });
setIO(io);

io.on('connection', (socket) => {
  // Admin joins a room based on their location so they only get relevant events
  socket.on('join_admin', (locationId) => {
    // Everyone joins 'admin_all' for truly global announcements
    socket.join('admin_all');
    if (locationId) {
      socket.join(`admin_loc_${locationId}`);
    } else {
      // Super admins only join this room to get all location-specific events without duplication
      socket.join('admin_super');
    }
  });
});

setupSwagger(app);

const PORT = process.env.PORT || 5000;

// ─── ENSURE DIRS ──────────────────────────────────────────────────
['uploads', 'uploads/products', 'uploads/categories', 'logs'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── SECURITY & GLOBAL MIDDLEWARES ───────────────────────────────
app.use(helmet());
app.use(cors({
  origin: '*',
  credentials: false,
}));

// Rate limiter — global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: { success: false, message: 'Too many requests. Please try again later.' },
}));

// Strict rate limiter for OTP
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { success: false, message: 'Too many OTP requests. Wait 1 minute.' },
});
app.use('/api/auth/send-otp', otpLimiter);

// PayU webhook needs urlencoded body (handled in route), not raw
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ─── STATIC FILES ─────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await getPool();
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ─── ROUTES ──────────────────────────────────────────────────────
app.use('/api', routes);

// ─── ERROR HANDLERS ──────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── START ───────────────────────────────────────────────────────
const start = async () => {
  try {
    const pool = await getPool();
    // Ensure PaymentInitiations table exists for the professional flow
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS PaymentInitiations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        txnid VARCHAR(100) NOT NULL UNIQUE,
        user_id INT NOT NULL,
        order_data TEXT NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_VALUE,
        updated_at TIMESTAMP DEFAULT CURRENT_VALUE ON UPDATE CURRENT_VALUE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `.replace('CURRENT_VALUE', 'CURRENT_TIMESTAMP'));

    server.listen(PORT, () => {
      logger.info(`🍕 PizzaHap Backend running on port ${PORT}`);
      console.log(`🍕 Server:  http://localhost:${PORT}`);
      console.log(`📋 Health:  http://localhost:${PORT}/health`);
      console.log(`📖 API Docs: http://localhost:${PORT}/api-docs`);
    });
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  const { closePool } = require('./config/db');
  await closePool();
  process.exit(0);
});

start();
