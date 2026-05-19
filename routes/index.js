const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const driverRoutes = require('./driver.routes');
const adminRoutes = require('./admin.routes');
const publicRoutes = require('./public.routes');

// Mount all route modules
router.use('/', publicRoutes);
router.use('/', authRoutes);
router.use('/', driverRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
