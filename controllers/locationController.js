const { query } = require('../config/db');
const { success, notFound } = require('../utils/response');

const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getAllLocations = async (req, res, next) => {
  try {
    const { latitude, longitude } = req.query;
    let locations = await query(`SELECT * FROM Locations WHERE is_active = 1 ORDER BY name`);

    if (latitude && longitude) {
      const userLat = parseFloat(latitude);
      const userLng = parseFloat(longitude);
      locations = locations.map(loc => ({
        ...loc,
        distance_km: parseFloat(haversineDistance(userLat, userLng, loc.latitude, loc.longitude).toFixed(2)),
      }));
      locations.sort((a, b) => a.distance_km - b.distance_km);
    }
    return success(res, locations);
  } catch (err) { next(err); }
};

const getNearestLocation = async (req, res, next) => {
  try {
    const { latitude, longitude } = req.query;
    if (!latitude || !longitude) {
      const result = await query(`SELECT * FROM Locations WHERE is_active = 1 LIMIT 1`);
      return success(res, result[0]);
    }

    const locations = await query(`SELECT * FROM Locations WHERE is_active = 1`);
    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);

    let nearest = null, minDist = Infinity;
    for (const loc of locations) {
      const dist = haversineDistance(userLat, userLng, loc.latitude, loc.longitude);
      if (dist < minDist) { minDist = dist; nearest = { ...loc, distance_km: parseFloat(dist.toFixed(2)) }; }
    }
    return success(res, nearest);
  } catch (err) { next(err); }
};

const getLocationById = async (req, res, next) => {
  try {
    const result = await query(`SELECT * FROM Locations WHERE id = ? AND is_active = 1`, [req.params.id]);
    if (!result.length) return notFound(res, 'Location not found');
    return success(res, result[0]);
  } catch (err) { next(err); }
};

module.exports = { getAllLocations, getNearestLocation, getLocationById };
