const express = require('express');
const { searchInventory, fetchCitySuggestions } = require('../controllers/searchController');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.get('/suggestions', asyncHandler(fetchCitySuggestions));
router.post('/', asyncHandler(searchInventory));

module.exports = router;
