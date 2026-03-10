const logger = require('../utils/logger');
const { validationResult } = require('express-validator');
const { badRequest } = require('../utils/response');

// Global error handler
const errorHandler = (err, req, res, next) => {
  logger.error(`${err.message} - ${req.method} ${req.originalUrl} - ${req.ip}`, { stack: err.stack });

  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File too large' });
  }

  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal Server Error'
    : err.message;

  return res.status(statusCode).json({ success: false, message });
};

// Validate express-validator results
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return badRequest(res, 'Validation failed', errors.array());
  }
  next();
};

// Not found handler
const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.originalUrl} not found` });
};

module.exports = { errorHandler, validate, notFoundHandler };
