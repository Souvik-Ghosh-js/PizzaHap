const express = require('express');
const router = express.Router();

router.use('/auth', require('./authRoutes'));
router.use('/locations', require('./locationRoutes'));
router.use('/menu', require('./menuRoutes'));
router.use('/orders', require('./orderRoutes'));
router.use('/payments', require('./paymentRoutes'));
router.use('/refunds', require('./refundRoutes'));
router.use('/support', require('./supportRoutes'));
router.use('/ratings', require('./ratingRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/coupons', require('./couponRoutes'));
router.use('/admin', require('./adminRoutes'));

module.exports = router;
