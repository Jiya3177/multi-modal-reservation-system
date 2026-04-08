const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  renderRegisterPage,
  renderLoginPage,
  renderAdminLoginPage,
  renderForgotPasswordPage,
  renderResetPasswordPage,
  registerUser,
  loginUser,
  loginAdmin,
  handleForgotPassword,
  handleResetPassword,
  logoutUser
} = require('../controllers/authController');

const router = express.Router();

router.get('/register', renderRegisterPage);
router.post('/register', asyncHandler(registerUser));
router.get('/login', renderLoginPage);
router.post('/login', asyncHandler(loginUser));
router.get('/admin/login', renderAdminLoginPage);
router.post('/admin/login', asyncHandler(loginAdmin));
router.get('/forgot-password', renderForgotPasswordPage);
router.post('/forgot-password', asyncHandler(handleForgotPassword));
router.get('/reset-password', asyncHandler(renderResetPasswordPage));
router.post('/reset-password', asyncHandler(handleResetPassword));
router.post('/logout', asyncHandler(logoutUser));

module.exports = router;
