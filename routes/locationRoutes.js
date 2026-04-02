// locationRoutes.js
const express = require('express');
const router = express.Router();
const { getAllLocations, getNearestLocation, getLocationById, checkGeofence } = require('../controllers/locationController');
router.get('/', getAllLocations);
router.get('/nearest', getNearestLocation);
router.get('/check-geofence', checkGeofence);
router.get('/:id', getLocationById);
module.exports = router;
