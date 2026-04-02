const express = require('express');
const router = express.Router();
const { getCategories, getProducts, getProductById, getFeaturedProducts, getToppings, getCrusts, getActiveBanners } = require('../controllers/menuController');

router.get('/banners', getActiveBanners);
router.get('/categories', getCategories);
router.get('/products', getProducts);
router.get('/products/featured', getFeaturedProducts);
router.get('/products/:id', getProductById);
router.get('/toppings', getToppings);
router.get('/crusts', getCrusts);

module.exports = router;
