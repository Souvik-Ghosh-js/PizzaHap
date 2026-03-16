require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');

const { getPool }   = require('./config/db');
const routes        = require('./routes');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');
const logger        = require('./utils/logger');
const { setupSwagger } = require('./swagger');

const app  = express();
setupSwagger(app);

const PORT = process.env.PORT || 5000;

// ─── ENSURE DIRS ──────────────────────────────────────────────────
['uploads', 'uploads/products', 'uploads/categories', 'logs'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── SECURITY & GLOBAL MIDDLEWARES ───────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://13.232.73.121'])
    : '*',
  credentials: true,
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
    await getPool();
    app.listen(PORT, () => {
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
