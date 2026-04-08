const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { isValidEmail, isValidPhone } = require('../utils/helpers');
const { sendPasswordResetCodeEmail } = require('../utils/mailService');

const SEEDED_ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const SEEDED_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SEEDED_ADMIN_NAME = process.env.ADMIN_NAME || 'Main Admin';

async function ensureWalletTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet (
      wallet_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      balance DECIMAL(10,2) NOT NULL DEFAULT 50000,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);
}

async function ensurePasswordResetTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      reset_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_password_resets_user_id (user_id),
      INDEX idx_password_resets_token_hash (token_hash),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);
}

async function ensureAdminAccount() {
  if (!SEEDED_ADMIN_EMAIL || !SEEDED_ADMIN_PASSWORD) return;

  const [rows] = await pool.query('SELECT admin_id FROM admin WHERE email = ?', [SEEDED_ADMIN_EMAIL]);
  if (rows.length) return;

  const passwordHash = await bcrypt.hash(SEEDED_ADMIN_PASSWORD, 12);
  await pool.query(
    'INSERT INTO admin (full_name, email, password_hash) VALUES (?, ?, ?)',
    [SEEDED_ADMIN_NAME, SEEDED_ADMIN_EMAIL, passwordHash]
  );
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function renderRegisterPage(req, res) {
  res.render('auth/register', { error: null });
}

function renderLoginPage(req, res) {
  res.render('auth/login', { error: null });
}

function renderAdminLoginPage(req, res) {
  res.render('auth/admin-login', { error: null });
}

function renderForgotPasswordPage(req, res) {
  res.render('auth/forgot-password', { error: null, message: null });
}

function hashVerificationCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function findValidVerificationCode(email, code) {
  if (!email || !code) return null;

  await ensurePasswordResetTable();
  const tokenHash = hashVerificationCode(code);
  const [rows] = await pool.query(
    `SELECT pr.reset_id, pr.user_id, u.email
     FROM password_resets pr
     INNER JOIN users u ON u.user_id = pr.user_id
     WHERE u.email = ?
       AND pr.token_hash = ?
       AND pr.used_at IS NULL
       AND pr.expires_at > NOW()
     ORDER BY pr.reset_id DESC
     LIMIT 1`,
    [email, tokenHash]
  );

  return rows[0] || null;
}

async function renderResetPasswordPage(req, res) {
  const email = req.query.email || '';
  res.render('auth/reset-password', {
    error: null,
    message: null,
    email
  });
}

async function registerUser(req, res) {
  const full_name = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const password = String(req.body.password || '');

  if (!full_name) {
    return res.render('auth/register', { error: 'Enter your full name.' });
  }

  if (!isValidEmail(email)) {
    return res.render('auth/register', { error: 'Enter a valid email address.' });
  }

  if (!isValidPhone(phone)) {
    return res.render('auth/register', { error: 'Enter a valid 10-digit phone number.' });
  }

  if (!password || password.length < 6) {
    return res.render('auth/register', { error: 'Password must be at least 6 characters long.' });
  }

  const [existing] = await pool.query('SELECT email, phone FROM users WHERE email = ? OR phone = ?', [email, phone]);
  if (existing.length) {
    const matchedEmail = existing.some((user) => user.email === email);
    const matchedPhone = existing.some((user) => user.phone === phone);

    if (matchedEmail && matchedPhone) {
      return res.render('auth/register', { error: 'An account already exists with this email and phone number.' });
    }

    if (matchedEmail) {
      return res.render('auth/register', { error: 'An account already exists with this email address.' });
    }

    if (matchedPhone) {
      return res.render('auth/register', { error: 'An account already exists with this phone number.' });
    }

    return res.render('auth/register', { error: 'User already exists with the provided details.' });
  }

  const hashed = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [full_name, email, phone, hashed, 'user']
  );

  req.flash('success', 'Registration successful. Please login.');
  res.redirect('/auth/login');
}

async function loginUser(req, res) {
  const { emailOrPhone, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ? OR phone = ?', [emailOrPhone, emailOrPhone]);

  if (!rows.length) {
    return res.render('auth/login', { error: 'Invalid credentials.' });
  }

  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.render('auth/login', { error: 'Invalid credentials.' });
  }

  await regenerateSession(req);

  req.session.user = {
    user_id: user.user_id,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    role: user.role
  };

  await ensureWalletTable();
  await pool.query(
    `INSERT INTO wallet (user_id, balance)
     SELECT ?, 50000
     FROM DUAL
     WHERE NOT EXISTS (SELECT 1 FROM wallet WHERE user_id = ?)`,
    [user.user_id, user.user_id]
  );

  req.flash('success', 'Welcome back.');
  res.redirect('/dashboard');
}

async function loginAdmin(req, res) {
  await ensureAdminAccount();

  const { email, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM admin WHERE email = ?', [email]);

  if (!rows.length) {
    return res.render('auth/admin-login', { error: 'Invalid admin credentials.' });
  }

  const admin = rows[0];
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) {
    return res.render('auth/admin-login', { error: 'Invalid admin credentials.' });
  }

  await regenerateSession(req);

  req.session.admin = {
    admin_id: admin.admin_id,
    full_name: admin.full_name,
    email: admin.email
  };

  req.flash('success', 'Admin login successful.');
  res.redirect('/admin');
}

async function handleForgotPassword(req, res) {
  const { email } = req.body;
  const genericMessage = 'If the email is registered, password reset instructions will be shared through the configured recovery flow.';

  if (!isValidEmail(email)) {
    return res.render('auth/forgot-password', { error: 'Enter valid email.', message: null });
  }

  await ensurePasswordResetTable();
  const [users] = await pool.query('SELECT user_id, full_name, email FROM users WHERE email = ? LIMIT 1', [email]);
  if (!users.length) {
    return res.render('auth/forgot-password', {
      error: null,
      message: genericMessage
    });
  }

  const user = users[0];
  const verificationCode = crypto.randomInt(100000, 1000000).toString();
  const tokenHash = hashVerificationCode(verificationCode);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30);

  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [user.user_id]);
  await pool.query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [user.user_id, tokenHash, expiresAt]
  );

  let mailResult = { success: false };
  try {
    mailResult = await sendPasswordResetCodeEmail({
      to: user.email,
      fullName: user.full_name,
      verificationCode,
      expiresMinutes: 30
    });
  } catch (mailErr) {
    console.warn(`Password reset email delivery failed for ${user.email}: ${mailErr.message}`);
  }

  if (!mailResult.success) {
    return res.render('auth/forgot-password', {
      error: 'Verification email could not be sent. Please check SMTP/Gmail configuration and try again.',
      message: null
    });
  }

  return res.render('auth/reset-password', {
    error: null,
    message: 'A 6-digit verification code has been sent to your email.',
    email: user.email
  });
}

async function handleResetPassword(req, res) {
  const { email, verificationCode, password, confirmPassword } = req.body;

  if (!email || !verificationCode) {
    return res.status(400).render('auth/reset-password', {
      error: 'Email and Verification code are required.',
      message: null,
      email
    });
  }

  if (!isValidEmail(email) || !/^\d{6}$/.test(verificationCode)) {
    return res.status(400).render('auth/reset-password', {
      error: 'Enter a valid email and 6-digit verification code.',
      message: null,
      email
    });
  }

  if (!password || password.length < 6) {
    return res.status(400).render('auth/reset-password', {
      error: 'Password must be at least 6 characters long.',
      message: null,
      email
    });
  }

  if (password !== confirmPassword) {
    return res.status(400).render('auth/reset-password', {
      error: 'Password confirmation does not match.',
      message: null,
      email
    });
  }

  const resetRecord = await findValidVerificationCode(email, verificationCode);
  if (!resetRecord) {
    return res.status(400).render('auth/reset-password', {
      error: 'The verification code is invalid or has expired.',
      message: null,
      email
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [passwordHash, resetRecord.user_id]);
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE reset_id = ?', [resetRecord.reset_id]);

  req.flash('success', 'Password updated successfully. Please login with your new password.');
  res.redirect('/auth/login');
}

async function logoutUser(req, res) {
  await destroySession(req);
  res.clearCookie('connect.sid');
  res.redirect('/');
}

module.exports = {
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
};
