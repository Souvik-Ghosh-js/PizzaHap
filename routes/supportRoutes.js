// supportRoutes.js
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { createTicket, getMyTickets, getTicketById, replyToTicket } = require('../controllers/supportController');
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/errorHandler');

router.post('/tickets', authenticate, [
  body('subject').trim().notEmpty(),
  body('category').isIn(['order_issue','payment','refund','delivery','other']),
  body('message').trim().notEmpty(),
], validate, createTicket);
router.get('/tickets', authenticate, getMyTickets);
router.get('/tickets/:id', authenticate, getTicketById);
router.post('/tickets/:id/reply', authenticate, [
  body('message').trim().notEmpty(),
], validate, replyToTicket);

module.exports = router;
