const express = require('express');
const router = express.Router();
const { getNotifications, markAllRead, markOneRead } = require('../controllers/miscController');
const { authenticate } = require('../middlewares/auth');

router.get('/', authenticate, getNotifications);
router.put('/read-all', authenticate, markAllRead);
router.put('/:id/read', authenticate, markOneRead);

module.exports = router;
