// locationRoutes.js
const express = require('express');
const router = express.Router();
const { getAllLocations, getNearestLocation, getLocationById } = require('../controllers/locationController');
router.get('/', getAllLocations);
router.get('/nearest', getNearestLocation);
router.get('/:id', getLocationById);
module.exports = router;
