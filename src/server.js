const path = require('path');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const dotenv = require('dotenv');
const pool = require('./config/db');
const { exposeSession } = require('./middleware/auth');
const { exposeCsrfToken, requireCsrf } = require('./middleware/csrf');
const { ensureDemoInventoryCoverage } = require('./utils/bootstrapDemoInventory');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const configuredSessionSecret = process.env.SESSION_SECRET;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && (!configuredSessionSecret || configuredSessionSecret.length < 32 || configuredSessionSecret === 'replace_with_strong_secret')) {
  throw new Error('A strong SESSION_SECRET must be configured in production.');
}

const sessionSecret = configuredSessionSecret && configuredSessionSecret !== 'replace_with_strong_secret'
  ? configuredSessionSecret
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-dev-session-secret`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '../public')));

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use(exposeSession);
app.use(exposeCsrfToken);
app.use(requireCsrf);

app.use('/', require('./routes/indexRoutes'));
app.use('/auth', require('./routes/authRoutes'));
app.use('/api', require('./routes/paymentApiRoutes'));
app.use('/search', require('./routes/searchRoutes'));
app.use('/booking', require('./routes/bookingRoutes'));
app.use('/admin', require('./routes/adminRoutes'));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, database: 'disconnected', error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).render('pages/404');
});

app.use((err, req, res, next) => {
  if (err.status === 403) {
    const isApiRoute = req.originalUrl.startsWith('/api/');
    const csrfLogMessage = `CSRF validation failed for ${req.method} ${req.originalUrl}`;
    console.warn(csrfLogMessage);

    if (isApiRoute) {
      return res.status(403).json({ ok: false, error: 'Security validation failed. Please refresh and try again.' });
    }

    req.session.flash = { type: 'error', message: 'Security validation failed. Please refresh and try again.' };
    const backTarget = req.get('Referrer') || '/';
    return res.status(403).redirect(backTarget);
  }

  console.error('Unhandled error:', err);

  res.status(500).send('Something went wrong. Please try again.');
});

async function startServer() {
  try {
    await pool.query('SELECT 1');
    await ensureDemoInventoryCoverage();
  } catch (err) {
    console.error('Startup inventory bootstrap error:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`ORS running at http://localhost:${PORT}`);
  });
}

startServer();
