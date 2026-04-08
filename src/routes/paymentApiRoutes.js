const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  initiateUpiPayment,
  confirmUpiPayment,
  verifyUpiOtp,
  getWalletBalanceApi,
  getBookingHistoryApi,
  getBookingReceiptApi
} = require('../controllers/bookingController');
const { requireUser } = require('../middleware/auth');

const router = express.Router();

router.post('/pay', requireUser, asyncHandler(initiateUpiPayment));
router.post('/confirm-upi', requireUser, asyncHandler(confirmUpiPayment));
router.post('/verify-otp', requireUser, asyncHandler(verifyUpiOtp));
router.get('/booking-history', requireUser, asyncHandler(getBookingHistoryApi));
router.get('/booking-history/:bookingId', requireUser, asyncHandler(getBookingReceiptApi));
router.get('/wallet-balance', requireUser, asyncHandler(getWalletBalanceApi));

module.exports = router;
