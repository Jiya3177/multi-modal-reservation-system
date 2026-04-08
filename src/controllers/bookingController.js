const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const {
  generateReservationId,
  generateTransactionRef,
  generateOtp,
  getInventoryConfig,
  getUnitLayoutConfig,
  generateUnitLabels,
  isLadyReservedSeat,
  isWindowSeat,
  isValidEmail,
  isValidPhone
} = require('../utils/helpers');
const { sendSms, sendOtpSms, isSmsConfigured } = require('../utils/smsService');
const { getLocalDateString } = require('../utils/dateTime');

const VALID_PAYMENT_METHODS = new Set(['UPI', 'CARD', 'NET_BANKING']);
const VALID_GENDERS = new Set(['MALE', 'FEMALE', 'OTHER']);
const PAYMENT_PENDING_STATUSES = new Set(['INITIATED', 'OTP_PENDING']);
const UPI_MERCHANT_NAME = 'ORS Reservation Hub';
const UPI_ID = 'reservation@okaxis';
const OTP_EXPIRY_MINUTES = 5;
const HOLD_EXPIRY_MINUTES = 15;
const MAX_PAYMENT_PASSWORD_ATTEMPTS = 3;

let schemaReadyPromise = null;

async function ensureBookingSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
          transaction_id INT AUTO_INCREMENT PRIMARY KEY,
          booking_id INT NOT NULL,
          user_id INT NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          merchant_name VARCHAR(120) NOT NULL,
          upi_id VARCHAR(120) NOT NULL,
          transaction_ref VARCHAR(60) NOT NULL UNIQUE,
          otp_code_hash VARCHAR(255) NOT NULL,
          otp_phone VARCHAR(20) NOT NULL,
          status ENUM('INITIATED','OTP_PENDING','SUCCESS','FAILED','EXPIRED') DEFAULT 'INITIATED',
          expires_at DATETIME NOT NULL,
          verified_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_seats (
          booking_seat_id INT AUTO_INCREMENT PRIMARY KEY,
          booking_id INT NOT NULL,
          seat_label VARCHAR(20) NOT NULL,
          is_lady_reserved TINYINT(1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_booking_seat (booking_id, seat_label),
          FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE CASCADE
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_passengers (
          booking_passenger_id INT AUTO_INCREMENT PRIMARY KEY,
          booking_id INT NOT NULL,
          passenger_index INT NOT NULL,
          unit_label VARCHAR(20) NULL,
          full_name VARCHAR(100) NOT NULL,
          email VARCHAR(100) NOT NULL,
          phone VARCHAR(15) NOT NULL,
          gender VARCHAR(12) NULL,
          is_primary TINYINT(1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_booking_passenger (booking_id, passenger_index),
          FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE CASCADE
        )
      `);

      const [genderCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'bookings'
          AND COLUMN_NAME = 'passenger_gender'
      `);

      if (!genderCol[0].total) {
        await pool.query('ALTER TABLE bookings ADD COLUMN passenger_gender VARCHAR(12) NULL AFTER passenger_phone');
      }

      const [otpHashCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'transactions'
          AND COLUMN_NAME = 'otp_code_hash'
      `);

      if (!otpHashCol[0].total) {
        await pool.query('ALTER TABLE transactions ADD COLUMN otp_code_hash VARCHAR(255) NULL AFTER transaction_ref');
      }

      const [otpPhoneCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'transactions'
          AND COLUMN_NAME = 'otp_phone'
      `);

      if (!otpPhoneCol[0].total) {
        await pool.query('ALTER TABLE transactions ADD COLUMN otp_phone VARCHAR(20) NULL AFTER otp_code_hash');
      }

      const [legacyOtpCodeCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'transactions'
          AND COLUMN_NAME = 'otp_code'
      `);

      if (legacyOtpCodeCol[0].total) {
        await pool.query(`
          UPDATE transactions
          SET otp_code_hash = COALESCE(NULLIF(otp_code_hash, ''), otp_code),
              otp_phone = COALESCE(NULLIF(otp_phone, ''), '')
          WHERE otp_code IS NOT NULL
            AND (otp_code_hash IS NULL OR otp_code_hash = '')
        `);

        await pool.query('ALTER TABLE transactions DROP COLUMN otp_code');
      }

      await pool.query(`
        ALTER TABLE transactions
        MODIFY otp_code_hash VARCHAR(255) NOT NULL,
        MODIFY otp_phone VARCHAR(20) NOT NULL
      `);

      const [checkoutCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'bookings'
          AND COLUMN_NAME = 'check_out_date'
      `);

      if (!checkoutCol[0].total) {
        await pool.query('ALTER TABLE bookings ADD COLUMN check_out_date DATE NULL AFTER travel_date');
      }

      const [paymentAuthAttemptsCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'bookings'
          AND COLUMN_NAME = 'payment_auth_attempts'
      `);

      if (!paymentAuthAttemptsCol[0].total) {
        await pool.query('ALTER TABLE bookings ADD COLUMN payment_auth_attempts INT NOT NULL DEFAULT 0 AFTER booking_status');
      }

      const [holdBookingCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'seats_rooms'
          AND COLUMN_NAME = 'hold_booking_id'
      `);

      if (!holdBookingCol[0].total) {
        await pool.query('ALTER TABLE seats_rooms ADD COLUMN hold_booking_id INT NULL AFTER status');
      }

      const [holdExpiryCol] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'seats_rooms'
          AND COLUMN_NAME = 'hold_expires_at'
      `);

      if (!holdExpiryCol[0].total) {
        await pool.query('ALTER TABLE seats_rooms ADD COLUMN hold_expires_at DATETIME NULL AFTER hold_booking_id');
      }

      await pool.query(`
        DELETE sr1
        FROM seats_rooms sr1
        JOIN seats_rooms sr2
          ON sr1.inventory_type = sr2.inventory_type
         AND sr1.inventory_id = sr2.inventory_id
         AND sr1.label = sr2.label
         AND sr1.seat_room_id > sr2.seat_room_id
      `);

      const [seatRoomUniqueIndex] = await pool.query(`
        SELECT COUNT(*) AS total
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'seats_rooms'
          AND INDEX_NAME = 'uniq_inventory_unit'
      `);

      if (!seatRoomUniqueIndex[0].total) {
        await pool.query('ALTER TABLE seats_rooms ADD UNIQUE KEY uniq_inventory_unit (inventory_type, inventory_id, label)');
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS wallet (
          wallet_id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL UNIQUE,
          balance DECIMAL(10,2) NOT NULL DEFAULT 50000,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        )
      `);

      await pool.query(`
        INSERT INTO wallet (user_id, balance)
        SELECT u.user_id, 50000
        FROM users u
        LEFT JOIN wallet w ON w.user_id = u.user_id
        WHERE w.user_id IS NULL
      `);
    })();
  }

  return schemaReadyPromise;
}

async function ensureUnitInventory(connection, type, inventoryId, totalUnits) {
  const labels = generateUnitLabels(type, totalUnits);

  const [existingRows] = await connection.query(
    'SELECT label FROM seats_rooms WHERE inventory_type = ? AND inventory_id = ?',
    [type, inventoryId]
  );

  const existing = new Set(existingRows.map((row) => row.label));
  const missingLabels = labels.filter((label) => !existing.has(label));

  if (missingLabels.length) {
    const values = missingLabels.map((label) => [type, inventoryId, label, 'AVAILABLE']);
    await connection.query('INSERT IGNORE INTO seats_rooms (inventory_type, inventory_id, label, status) VALUES ?', [values]);
  }

  return labels;
}

async function ensureWalletForUser(connection, userId) {
  await connection.query(
    `INSERT INTO wallet (user_id, balance)
     SELECT ?, 50000
     FROM DUAL
     WHERE NOT EXISTS (SELECT 1 FROM wallet WHERE user_id = ?)`,
    [userId, userId]
  );
}

async function getWalletSummary(userId) {
  await pool.query(
    `INSERT INTO wallet (user_id, balance)
     SELECT ?, 50000
     FROM DUAL
     WHERE NOT EXISTS (SELECT 1 FROM wallet WHERE user_id = ?)`,
    [userId, userId]
  );

  const [[wallet]] = await pool.query('SELECT balance, updated_at FROM wallet WHERE user_id = ?', [userId]);
  return wallet;
}

function getFormattedTimestamp(date = new Date()) {
  return date.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getAppBaseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function getTicketLinks(req, bookingId) {
  const baseUrl = getAppBaseUrl(req);
  return {
    historyUrl: `${baseUrl}/booking/history/${bookingId}`,
    printUrl: `${baseUrl}/booking/ticket/${bookingId}/print`
  };
}

function getDisplayModelName(booking) {
  if (booking.booking_type === 'hotel') {
    return booking.hotel_name || 'Hotel Reservation';
  }

  const operator = booking.operator_name || 'ORS Transport';
  const code = booking.inventory_code ? ` ${booking.inventory_code}` : '';
  return `${operator}${code}`.trim();
}

async function sendPaymentLifecycleSms(req, booking, walletBalance) {
  if (!isSmsConfigured()) return;

  const links = getTicketLinks(req, booking.booking_id);
  const modelName = getDisplayModelName(booking);
  const unitTitle = booking.booking_type === 'hotel' ? 'Rooms' : 'Seats';
  const unitValue = booking.unit_labels || booking.units;
  const travelLabel = booking.booking_type === 'hotel'
    ? `${booking.travel_date}${booking.check_out_date ? ` to ${booking.check_out_date}` : ''}`
    : `${booking.travel_date} ${booking.depart_time || ''}`.trim();

  const confirmationMessage = [
    `ORS booking confirmed.`,
    `ID: ${booking.reservation_id}`,
    `Model: ${modelName}`,
    `${unitTitle}: ${unitValue}`,
    `Date: ${travelLabel}`,
    `Amount: INR ${Number(booking.total_price).toFixed(2)}`
  ].join(' ');

  const ticketMessage = [
    `ORS e-ticket ready.`,
    `Booking ID: ${booking.reservation_id}.`,
    `Open printable ticket: ${links.printUrl}`
  ].join(' ');

  const walletMessage = [
    `ORS payment complete for ${booking.reservation_id}.`,
    `Wallet balance: INR ${Number(walletBalance).toFixed(2)}.`,
    `Trip details: ${links.historyUrl}`
  ].join(' ');

  try {
    await sendSms(booking.passenger_phone, confirmationMessage);
    await sendSms(booking.passenger_phone, ticketMessage);
    await sendSms(booking.passenger_phone, walletMessage);
  } catch (smsError) {
    console.warn(`Booking SMS delivery failed for ${booking.reservation_id}: ${smsError.message}`);
  }
}

async function sendPendingBookingSms(req, booking) {
  if (!isSmsConfigured()) return;

  const links = getTicketLinks(req, booking.booking_id);
  const modelName = getDisplayModelName(booking);
  const unitTitle = booking.booking_type === 'hotel' ? 'Rooms' : 'Seats';
  const unitValue = booking.unit_labels || booking.units;
  const travelLabel = booking.booking_type === 'hotel'
    ? `${booking.travel_date}${booking.check_out_date ? ` to ${booking.check_out_date}` : ''}`
    : `${booking.travel_date} ${booking.depart_time || ''}`.trim();

  const pendingMessage = [
    `ORS booking pending payment.`,
    `ID: ${booking.reservation_id}.`,
    `Model: ${modelName}.`,
    `${unitTitle}: ${unitValue}.`,
    `Date: ${travelLabel}.`,
    `Complete payment: ${links.historyUrl}`
  ].join(' ');

  try {
    await sendSms(booking.passenger_phone, pendingMessage);
  } catch (smsError) {
    console.warn(`Pending booking SMS delivery failed for ${booking.reservation_id}: ${smsError.message}`);
  }
}

async function sendCancellationSms(req, booking, refundAmount = null) {
  if (!isSmsConfigured()) return;

  const modelName = getDisplayModelName(booking);
  const refundText = refundAmount !== null ? ` Refund: INR ${Number(refundAmount).toFixed(2)}.` : '';
  const message = [
    `ORS cancellation confirmed.`,
    `ID: ${booking.reservation_id}.`,
    `Model: ${modelName}.`,
    `Status: CANCELLED.${refundText}`
  ].join(' ');

  try {
    await sendSms(booking.passenger_phone, message);
  } catch (smsError) {
    console.warn(`Cancellation SMS delivery failed for ${booking.reservation_id}: ${smsError.message}`);
  }
}

async function releaseExpiredHolds(connection, type, inventoryId) {
  await connection.query(
    `UPDATE seats_rooms
     SET hold_booking_id = NULL, hold_expires_at = NULL
     WHERE inventory_type = ?
       AND inventory_id = ?
       AND hold_booking_id IS NOT NULL
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at < NOW()`,
    [type, inventoryId]
  );
}

async function clearSeatHold(connection, bookingId) {
  await connection.query(
    `UPDATE seats_rooms
     SET hold_booking_id = NULL, hold_expires_at = NULL
     WHERE hold_booking_id = ?`,
    [bookingId]
  );
}

async function getBookingUnits(bookingId) {
  const [bookingSeats] = await pool.query(
    'SELECT seat_label, is_lady_reserved FROM booking_seats WHERE booking_id = ? ORDER BY seat_label',
    [bookingId]
  );

  return bookingSeats;
}

async function findBookingForUser(userId, bookingId) {
  const [rows] = await pool.query(
    'SELECT * FROM bookings WHERE booking_id = ? AND user_id = ?',
    [bookingId, userId]
  );

  return rows[0] || null;
}

async function findLatestTransaction(connection, bookingId, userId) {
  const [rows] = await connection.query(
    `SELECT *
     FROM transactions
     WHERE booking_id = ? AND user_id = ?
     ORDER BY transaction_id DESC
     LIMIT 1`,
    [bookingId, userId]
  );

  return rows[0] || null;
}

async function findPendingTransaction(connection, bookingId, userId) {
  const [rows] = await connection.query(
    `SELECT *
     FROM transactions
     WHERE booking_id = ?
       AND user_id = ?
       AND status IN ('INITIATED', 'OTP_PENDING')
     ORDER BY transaction_id DESC
     LIMIT 1
     FOR UPDATE`,
    [bookingId, userId]
  );

  return rows[0] || null;
}

async function expireStaleTransactions(connection, bookingId, userId) {
  await connection.query(
    `UPDATE transactions
     SET status = 'EXPIRED'
     WHERE booking_id = ?
       AND user_id = ?
       AND status IN ('INITIATED', 'OTP_PENDING')
       AND expires_at < NOW()`,
    [bookingId, userId]
  );
}

async function cancelPendingPaymentBooking(connection, bookingId, userId) {
  await connection.query(
    'UPDATE bookings SET booking_status = ?, payment_auth_attempts = 0 WHERE booking_id = ? AND user_id = ?',
    ['CANCELLED', bookingId, userId]
  );
  await connection.query(
    `UPDATE transactions
     SET status = 'FAILED'
     WHERE booking_id = ?
       AND user_id = ?
       AND status IN ('INITIATED', 'OTP_PENDING')`,
    [bookingId, userId]
  );
  await clearSeatHold(connection, bookingId);
}

async function verifyPaymentPassword(connection, booking, userId, password) {
  const submittedPassword = String(password || '');

  if (!submittedPassword) {
    return {
      ok: false,
      attemptsRemaining: MAX_PAYMENT_PASSWORD_ATTEMPTS - Number(booking.payment_auth_attempts || 0),
      message: 'Enter your login password to continue payment.'
    };
  }

  const [[userRow]] = await connection.query(
    'SELECT password_hash FROM users WHERE user_id = ? LIMIT 1',
    [userId]
  );

  if (!userRow) {
    throw new Error('User account not found.');
  }

  const passwordMatches = await bcrypt.compare(submittedPassword, userRow.password_hash);
  if (passwordMatches) {
    if (Number(booking.payment_auth_attempts || 0) !== 0) {
      await connection.query('UPDATE bookings SET payment_auth_attempts = 0 WHERE booking_id = ?', [booking.booking_id]);
    }
    return { ok: true, attemptsRemaining: MAX_PAYMENT_PASSWORD_ATTEMPTS };
  }

  const nextAttempts = Number(booking.payment_auth_attempts || 0) + 1;
  if (nextAttempts >= MAX_PAYMENT_PASSWORD_ATTEMPTS) {
    await cancelPendingPaymentBooking(connection, booking.booking_id, userId);
    return {
      ok: false,
      attemptsRemaining: 0,
      bookingCancelled: true,
      message: 'Incorrect password entered 3 times. Booking and payment were cancelled.'
    };
  }

  await connection.query('UPDATE bookings SET payment_auth_attempts = ? WHERE booking_id = ?', [nextAttempts, booking.booking_id]);
  return {
    ok: false,
    attemptsRemaining: MAX_PAYMENT_PASSWORD_ATTEMPTS - nextAttempts,
    message: `Incorrect password. ${MAX_PAYMENT_PASSWORD_ATTEMPTS - nextAttempts} attempt(s) left.`
  };
}

async function getBookingHistoryRows(userId) {
  const [bookings] = await pool.query(
    `SELECT b.booking_id, b.reservation_id, b.booking_type, b.reference_id, b.travel_date, b.check_out_date, b.total_price, b.booking_status, b.created_at,
            COALESCE(t.status, p.payment_status, 'PENDING') AS transaction_status,
            t.transaction_ref, t.verified_at,
            p.payment_status,
            CASE
              WHEN b.booking_type = 'hotel' THEN h.hotel_name
              ELSE CONCAT(src.city_name, ' to ', dest.city_name)
            END AS route_label
     FROM bookings b
     LEFT JOIN (
       SELECT t1.*
       FROM transactions t1
       JOIN (
         SELECT booking_id, MAX(transaction_id) AS latest_id
         FROM transactions
         GROUP BY booking_id
       ) latest ON latest.latest_id = t1.transaction_id
     ) t ON t.booking_id = b.booking_id
     LEFT JOIN (
       SELECT p1.*
       FROM payments p1
       JOIN (
         SELECT booking_id, MAX(payment_id) AS latest_id
         FROM payments
         GROUP BY booking_id
       ) latest_payment ON latest_payment.latest_id = p1.payment_id
     ) p ON p.booking_id = b.booking_id
     LEFT JOIN flights f ON b.booking_type = 'flight' AND b.reference_id = f.flight_id
     LEFT JOIN trains tr ON b.booking_type = 'train' AND b.reference_id = tr.train_id
     LEFT JOIN buses bs ON b.booking_type = 'bus' AND b.reference_id = bs.bus_id
     LEFT JOIN hotels h ON b.booking_type = 'hotel' AND b.reference_id = h.hotel_id
     LEFT JOIN cities src ON src.city_id = COALESCE(f.source_city_id, tr.source_city_id, bs.source_city_id)
     LEFT JOIN cities dest ON dest.city_id = COALESCE(f.destination_city_id, tr.destination_city_id, bs.destination_city_id)
     WHERE b.user_id = ?
     ORDER BY b.created_at DESC`,
    [userId]
  );

  return bookings;
}

async function getBookingReceiptData(userId, bookingId) {
  const [rows] = await pool.query(
    `SELECT b.*,
            COALESCE(t.status, p.payment_status, 'PENDING') AS transaction_status,
            COALESCE(t.transaction_ref, p.transaction_ref) AS transaction_ref,
            t.verified_at,
            COALESCE(t.upi_id, 'reservation@okaxis') AS upi_id,
            COALESCE(t.merchant_name, 'ORS Reservation Hub') AS merchant_name,
            CASE
              WHEN b.booking_type = 'hotel' THEN h.hotel_name
              ELSE CONCAT(src.city_name, ' to ', dest.city_name)
            END AS route_label
     FROM bookings b
     LEFT JOIN (
       SELECT t1.*
       FROM transactions t1
       JOIN (
         SELECT booking_id, MAX(transaction_id) AS latest_id
         FROM transactions
         GROUP BY booking_id
       ) latest ON latest.latest_id = t1.transaction_id
     ) t ON t.booking_id = b.booking_id
     LEFT JOIN (
       SELECT p1.*
       FROM payments p1
       JOIN (
         SELECT booking_id, MAX(payment_id) AS latest_id
         FROM payments
         GROUP BY booking_id
       ) latest_payment ON latest_payment.latest_id = p1.payment_id
     ) p ON p.booking_id = b.booking_id
     LEFT JOIN flights f ON b.booking_type = 'flight' AND b.reference_id = f.flight_id
     LEFT JOIN trains tr ON b.booking_type = 'train' AND b.reference_id = tr.train_id
     LEFT JOIN buses bs ON b.booking_type = 'bus' AND b.reference_id = bs.bus_id
     LEFT JOIN hotels h ON b.booking_type = 'hotel' AND b.reference_id = h.hotel_id
     LEFT JOIN cities src ON src.city_id = COALESCE(f.source_city_id, tr.source_city_id, bs.source_city_id)
     LEFT JOIN cities dest ON dest.city_id = COALESCE(f.destination_city_id, tr.destination_city_id, bs.destination_city_id)
     WHERE b.booking_id = ? AND b.user_id = ?
     LIMIT 1`,
    [bookingId, userId]
  );

  return rows[0] || null;
}

async function getBookingMessagingData(userId, bookingId) {
  const [rows] = await pool.query(
    `SELECT b.*,
            f.operator_name AS flight_operator_name,
            f.code AS flight_code,
            f.depart_time AS flight_depart_time,
            tr.operator_name AS train_operator_name,
            tr.code AS train_code,
            tr.depart_time AS train_depart_time,
            bs.operator_name AS bus_operator_name,
            bs.code AS bus_code,
            bs.depart_time AS bus_depart_time,
            h.hotel_name,
            h.room_type,
            CASE
              WHEN b.booking_type = 'flight' THEN f.operator_name
              WHEN b.booking_type = 'train' THEN tr.operator_name
              WHEN b.booking_type = 'bus' THEN bs.operator_name
              ELSE h.hotel_name
            END AS operator_name,
            CASE
              WHEN b.booking_type = 'flight' THEN f.code
              WHEN b.booking_type = 'train' THEN tr.code
              WHEN b.booking_type = 'bus' THEN bs.code
              ELSE h.room_type
            END AS inventory_code,
            CASE
              WHEN b.booking_type = 'flight' THEN f.depart_time
              WHEN b.booking_type = 'train' THEN tr.depart_time
              WHEN b.booking_type = 'bus' THEN bs.depart_time
              ELSE NULL
            END AS depart_time,
            CASE
              WHEN b.booking_type = 'hotel' THEN h.hotel_name
              ELSE CONCAT(src.city_name, ' to ', dest.city_name)
            END AS route_label
     FROM bookings b
     LEFT JOIN flights f ON b.booking_type = 'flight' AND b.reference_id = f.flight_id
     LEFT JOIN trains tr ON b.booking_type = 'train' AND b.reference_id = tr.train_id
     LEFT JOIN buses bs ON b.booking_type = 'bus' AND b.reference_id = bs.bus_id
     LEFT JOIN hotels h ON b.booking_type = 'hotel' AND b.reference_id = h.hotel_id
     LEFT JOIN cities src ON src.city_id = COALESCE(f.source_city_id, tr.source_city_id, bs.source_city_id)
     LEFT JOIN cities dest ON dest.city_id = COALESCE(f.destination_city_id, tr.destination_city_id, bs.destination_city_id)
     WHERE b.booking_id = ? AND b.user_id = ?
     LIMIT 1`,
    [bookingId, userId]
  );

  if (!rows.length) return null;

  const booking = rows[0];
  const units = await getBookingUnits(bookingId);
  booking.unit_labels = units.map((unit) => unit.seat_label).join(', ');
  return booking;
}

async function renderUserDashboard(req, res) {
  await ensureBookingSchema();

  const userId = req.session.user.user_id;

  const [bookings] = await pool.query(
    `SELECT b.*,
            (SELECT p.payment_status
             FROM payments p
             WHERE p.booking_id = b.booking_id
             ORDER BY p.payment_id DESC
             LIMIT 1) AS payment_status
     FROM bookings b
     WHERE b.user_id = ?
     ORDER BY b.created_at DESC`,
    [userId]
  );

  const [notifications] = await pool.query(
    'SELECT title, message, channel, created_at FROM notifications WHERE user_id = ? ORDER BY notification_id DESC LIMIT 6',
    [userId]
  );

  const today = getLocalDateString();
  const upcoming = bookings.filter((b) => b.travel_date && b.travel_date >= today && b.booking_status !== 'CANCELLED');

  const totalSpent = bookings
    .filter((b) => b.booking_status === 'CONFIRMED')
    .reduce((sum, b) => sum + Number(b.total_price), 0);

  const wallet = await getWalletSummary(userId);

  res.render('user/dashboard', { bookings, upcoming, notifications, totalSpent, wallet });
}

async function fetchSeatMap(req, res) {
  await ensureBookingSchema();

  const { type, id } = req.params;
  if (!['flight', 'train', 'bus', 'hotel'].includes(type)) {
    return res.status(400).json({ error: 'Seat/room map not available for this type.' });
  }

  const config = getInventoryConfig(type);
  const [inventoryRows] = await pool.query(
    `SELECT ${config.totalCol} AS total_units, ${config.availabilityCol} AS available_units
     FROM ${config.table}
     WHERE ${config.id} = ?`,
    [id]
  );

  if (!inventoryRows.length) {
    return res.status(404).json({ error: 'Inventory not found.' });
  }

  const totalUnits = Number(inventoryRows[0].total_units) || 0;
  const availableUnits = Number(inventoryRows[0].available_units) || 0;

  const connection = await pool.getConnection();
  try {
    await releaseExpiredHolds(connection, type, id);
    const orderedLabels = await ensureUnitInventory(connection, type, id, totalUnits);

    const [unitRows] = await connection.query(
      `SELECT label, status, hold_booking_id, hold_expires_at
       FROM seats_rooms
       WHERE inventory_type = ? AND inventory_id = ?`,
      [type, id]
    );

    const statusMap = new Map(unitRows.map((row) => {
      const isHeld = row.hold_booking_id && row.hold_expires_at && new Date(row.hold_expires_at) > new Date();
      return [row.label, isHeld ? 'BOOKED' : row.status];
    }));

    const units = orderedLabels.map((label) => ({
      label,
      status: statusMap.get(label) || 'AVAILABLE',
      isLadyReserved: isLadyReservedSeat(type, label),
      isWindow: isWindowSeat(type, label)
    }));

    res.json({
      type,
      totalUnits,
      availableUnits,
      layout: getUnitLayoutConfig(type),
      units
    });
  } finally {
    connection.release();
  }
}

async function renderBookingPage(req, res) {
  await ensureBookingSchema();

  const { type, id } = req.params;
  const { people = 1, date = null, checkOut = null } = req.query;
  const config = getInventoryConfig(type);

  if (!config) {
    return res.status(400).send('Invalid booking type');
  }

  let query = `SELECT * FROM ${config.table} WHERE ${config.id} = ?`;
  const params = [id];

  if (date && type !== 'hotel') {
    query += ' AND travel_date = ?';
    params.push(date);
  }

  const [rows] = await pool.query(query, params);
  if (!rows.length) return res.status(404).send('Option not found');

  res.render('booking/booking-page', {
    item: rows[0],
    type,
    people: Number(people) || 1,
    selectedDate: date,
    selectedCheckoutDate: checkOut,
    error: null
  });
}

async function createReservation(req, res) {
  await ensureBookingSchema();

  const userId = req.session.user.user_id;
  const {
    type,
    item_id,
    units,
    check_in_date,
    check_out_date,
    passenger_name,
    passenger_email,
    passenger_phone,
    passenger_gender,
    seat_labels
  } = req.body;

  const gender = (passenger_gender || '').toUpperCase();
  const config = getInventoryConfig(type);

  if (!passenger_name || !isValidEmail(passenger_email) || !isValidPhone(passenger_phone)) {
    req.flash('error', 'Invalid passenger details.');
    return res.redirect('/dashboard');
  }

  if (!config) {
    req.flash('error', 'Invalid booking type.');
    return res.redirect('/');
  }

  const isTransport = ['flight', 'train', 'bus'].includes(type);
  const selectedCheckInDate = String(check_in_date || '').trim();
  const selectedCheckoutDate = String(check_out_date || '').trim();
  if (isTransport && !VALID_GENDERS.has(gender)) {
    req.flash('error', 'Please select passenger gender for seat reservation policy.');
    return res.redirect(`/booking/${type}/${item_id}`);
  }

  if (type === 'hotel' && !selectedCheckInDate) {
    req.flash('error', 'Please select a valid hotel check-in date.');
    return res.redirect('/');
  }

  if (type === 'hotel' && !selectedCheckoutDate) {
    req.flash('error', 'Please select a valid hotel check-out date.');
    return res.redirect('/');
  }

  let hotelNights = 1;
  if (type === 'hotel') {
    const checkInDate = new Date(`${selectedCheckInDate}T00:00:00`);
    const checkOutDate = new Date(`${selectedCheckoutDate}T00:00:00`);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
      req.flash('error', 'Please select valid hotel stay dates.');
      return res.redirect('/');
    }

    if (checkInDate < today) {
      req.flash('error', 'Hotel check-in date cannot be in the past.');
      return res.redirect('/');
    }

    if (checkOutDate <= checkInDate) {
      req.flash('error', 'Check-out date must be after check-in date.');
      return res.redirect('/');
    }

    hotelNights = Math.max(1, Math.round((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24)));
  }

  const selectedLabels = (seat_labels || '')
    .split(',')
    .map((label) => label.trim().toUpperCase())
    .filter(Boolean);

  if (!selectedLabels.length) {
    req.flash('error', type === 'hotel' ? 'Please select room(s) from map.' : 'Please select seat(s) from map.');
    return res.redirect(`/booking/${type}/${item_id}`);
  }

  const uniqueLabels = [...new Set(selectedLabels)];
  const quantity = uniqueLabels.length || Number(units) || 1;

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(`SELECT * FROM ${config.table} WHERE ${config.id} = ? FOR UPDATE`, [item_id]);
    if (!rows.length) {
      await connection.rollback();
      req.flash('error', 'Selected inventory not found.');
      return res.redirect('/');
    }

    const item = rows[0];
    await ensureUnitInventory(connection, type, item_id, Number(item[config.totalCol]));
    await releaseExpiredHolds(connection, type, item_id);

    const [unitRows] = await connection.query(
      `SELECT label, status, hold_booking_id, hold_expires_at
       FROM seats_rooms
       WHERE inventory_type = ? AND inventory_id = ? AND label IN (?) FOR UPDATE`,
      [type, item_id, uniqueLabels]
    );

    if (unitRows.length !== uniqueLabels.length) {
      await connection.rollback();
      req.flash('error', 'One or more selected units are invalid.');
      return res.redirect(`/booking/${type}/${item_id}`);
    }

    const conflictingUnit = unitRows.find((row) => {
      if (row.status === 'BOOKED') return true;
      if (!row.hold_booking_id || !row.hold_expires_at) return false;
      return new Date(row.hold_expires_at) > new Date();
    });

    if (conflictingUnit) {
      await connection.rollback();
      req.flash('error', type === 'hotel' ? 'Some selected rooms are already reserved.' : 'Some selected seats are already booked.');
      return res.redirect(`/booking/${type}/${item_id}`);
    }

    if (isTransport) {
      const ladyBlocked = uniqueLabels.find((label) => isLadyReservedSeat(type, label) && gender !== 'FEMALE');
      if (ladyBlocked) {
        await connection.rollback();
        req.flash('error', `${ladyBlocked} is ladies-reserved seat. Please choose another seat.`);
        return res.redirect(`/booking/${type}/${item_id}`);
      }
    }

    if (quantity < 1 || item[config.availabilityCol] < quantity) {
      await connection.rollback();
      req.flash('error', 'Selected seats/rooms are not available.');
      return res.redirect('/');
    }

    const total = Number(item[config.priceCol]) * quantity * (type === 'hotel' ? hotelNights : 1);
    const reservationId = generateReservationId();
    const travelDate = type === 'hotel' ? selectedCheckInDate : item.travel_date;

    const [result] = await connection.query(
      `INSERT INTO bookings
      (reservation_id, user_id, booking_type, reference_id, passenger_name, passenger_email, passenger_phone, passenger_gender, units, total_price, travel_date, check_out_date, booking_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservationId,
        userId,
        type,
        item_id,
        passenger_name,
        passenger_email,
        passenger_phone,
        gender || null,
        quantity,
        total,
        travelDate,
        type === 'hotel' ? selectedCheckoutDate : null,
        'PENDING_PAYMENT'
      ]
    );

    const seatValues = uniqueLabels.map((label) => [result.insertId, label, isLadyReservedSeat(type, label) ? 1 : 0]);
    await connection.query('INSERT INTO booking_seats (booking_id, seat_label, is_lady_reserved) VALUES ?', [seatValues]);

    const passengerValues = uniqueLabels.map((label, index) => [
      result.insertId,
      index + 1,
      label,
      passenger_name.trim(),
      passenger_email.trim(),
      passenger_phone.trim(),
      gender || null,
      index === 0 ? 1 : 0
    ]);
    await connection.query(
      `INSERT INTO booking_passengers
      (booking_id, passenger_index, unit_label, full_name, email, phone, gender, is_primary)
      VALUES ?`,
      [passengerValues]
    );

    await connection.query(
      `UPDATE seats_rooms
       SET hold_booking_id = ?, hold_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
       WHERE inventory_type = ? AND inventory_id = ? AND label IN (?)`,
      [result.insertId, HOLD_EXPIRY_MINUTES, type, item_id, uniqueLabels]
    );

    await connection.commit();

    const bookingMessageData = await getBookingMessagingData(userId, result.insertId);
    if (bookingMessageData) {
      await sendPendingBookingSms(req, bookingMessageData);
    }

    req.flash('success', 'Booking created. Complete payment to confirm your ticket.');
    res.redirect(`/booking/payment/${result.insertId}`);
  } catch (err) {
    await connection.rollback();
    console.error('Create booking error:', err);
    req.flash('error', 'Could not create booking. Please try again.');
    res.redirect('/');
  } finally {
    connection.release();
  }
}

async function finalizeBookingPayment(connection, booking, transactionRef, paymentMethod = 'UPI') {
  const config = getInventoryConfig(booking.booking_type);
  if (!config) {
    throw new Error('Inventory type mismatch.');
  }

  const [inventoryRows] = await connection.query(
    `SELECT ${config.availabilityCol}, ${config.totalCol} FROM ${config.table} WHERE ${config.id} = ? FOR UPDATE`,
    [booking.reference_id]
  );

  if (!inventoryRows.length) {
    throw new Error('Inventory not available now.');
  }

  const currentAvailability = Number(inventoryRows[0][config.availabilityCol]);
  if (currentAvailability < booking.units) {
    throw new Error('Seats/rooms sold out before payment. Please search again.');
  }

  const [bookingSeatRows] = await connection.query(
    'SELECT seat_label, is_lady_reserved FROM booking_seats WHERE booking_id = ? ORDER BY seat_label',
    [booking.booking_id]
  );

  if (bookingSeatRows.length !== booking.units) {
    throw new Error('Seat/room mapping mismatch. Please rebook.');
  }

  await ensureUnitInventory(connection, booking.booking_type, booking.reference_id, Number(inventoryRows[0][config.totalCol]));
  await releaseExpiredHolds(connection, booking.booking_type, booking.reference_id);

  const labels = bookingSeatRows.map((row) => row.seat_label);
  const [unitRows] = await connection.query(
    `SELECT label, status, hold_booking_id, hold_expires_at
     FROM seats_rooms
     WHERE inventory_type = ? AND inventory_id = ? AND label IN (?) FOR UPDATE`,
    [booking.booking_type, booking.reference_id, labels]
  );

  if (
    unitRows.length !== labels.length ||
    unitRows.some((row) => row.status === 'BOOKED') ||
    unitRows.some((row) => row.hold_booking_id && Number(row.hold_booking_id) !== Number(booking.booking_id) && row.hold_expires_at && new Date(row.hold_expires_at) > new Date())
  ) {
    throw new Error('Some selected seats/rooms are already reserved. Please rebook.');
  }

  if (
    ['flight', 'train', 'bus'].includes(booking.booking_type) &&
    booking.passenger_gender !== 'FEMALE' &&
    bookingSeatRows.some((row) => Number(row.is_lady_reserved) === 1)
  ) {
    throw new Error('Ladies reserved seat policy violation. Please rebook with valid seats.');
  }

  const amount = Number(booking.total_price);

  if (paymentMethod === 'UPI') {
    await ensureWalletForUser(connection, booking.user_id);

    const [[walletRow]] = await connection.query(
      'SELECT balance FROM wallet WHERE user_id = ? FOR UPDATE',
      [booking.user_id]
    );

    const walletBalance = Number(walletRow.balance);
    if (walletBalance < amount) {
      throw new Error('Insufficient wallet balance for this UPI payment.');
    }

    await connection.query(
      'UPDATE wallet SET balance = balance - ? WHERE user_id = ?',
      [amount, booking.user_id]
    );
  }

  await connection.query(
    `UPDATE seats_rooms
     SET status = ?, hold_booking_id = NULL, hold_expires_at = NULL
     WHERE inventory_type = ? AND inventory_id = ? AND label IN (?)`,
    ['BOOKED', booking.booking_type, booking.reference_id, labels]
  );

  await connection.query(
    'INSERT INTO payments (booking_id, amount, payment_method, transaction_ref, payment_status) VALUES (?, ?, ?, ?, ?)',
    [booking.booking_id, amount, paymentMethod, transactionRef, 'SUCCESS']
  );

  await connection.query('UPDATE bookings SET booking_status = ? WHERE booking_id = ?', ['CONFIRMED', booking.booking_id]);

  await connection.query(
    `UPDATE ${config.table} SET ${config.availabilityCol} = ${config.availabilityCol} - ? WHERE ${config.id} = ?`,
    [booking.units, booking.reference_id]
  );

  await connection.query(
    'INSERT INTO notifications (user_id, title, message, channel) VALUES (?, ?, ?, ?)',
    [booking.user_id, 'Booking Confirmed', `Your booking ${booking.reservation_id} is confirmed.`, 'email']
  );
}

async function renderPaymentPage(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.params.bookingId);
  const userId = req.session.user.user_id;

  const [rows] = await pool.query(
    'SELECT * FROM bookings WHERE booking_id = ? AND user_id = ?',
    [bookingId, userId]
  );

  if (!rows.length) return res.status(404).send('Booking not found');

  const booking = rows[0];
  if (booking.booking_status !== 'PENDING_PAYMENT') {
    req.flash('error', 'Payment is not pending for this booking.');
    return res.redirect('/dashboard');
  }

  const bookingSeats = await getBookingUnits(bookingId);
  const wallet = await getWalletSummary(userId);

  res.render('booking/payment-page', {
    booking,
    bookingSeats,
    wallet,
    merchantName: UPI_MERCHANT_NAME,
    upiId: UPI_ID,
    otpExpiryMinutes: OTP_EXPIRY_MINUTES,
    error: null
  });
}

async function initiateUpiPayment(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.body.bookingId);
  const userId = req.session.user.user_id;

  if (!bookingId) {
    return res.status(400).json({ ok: false, error: 'Booking ID is required.' });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await ensureWalletForUser(connection, userId);

    const [bookingRows] = await connection.query(
      'SELECT * FROM bookings WHERE booking_id = ? AND user_id = ? FOR UPDATE',
      [bookingId, userId]
    );

    if (!bookingRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, error: 'Booking not found.' });
    }

    const booking = bookingRows[0];
    if (booking.booking_status !== 'PENDING_PAYMENT') {
      await connection.rollback();
      return res.status(400).json({ ok: false, error: 'Booking payment is already completed.' });
    }

    const [[walletRow]] = await connection.query('SELECT balance FROM wallet WHERE user_id = ? FOR UPDATE', [userId]);
    const walletBalance = Number(walletRow.balance);

    await expireStaleTransactions(connection, bookingId, userId);

    const transactionRef = generateTransactionRef();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    const transactionStatus = 'INITIATED';

    await connection.query(
      `INSERT INTO transactions
      (booking_id, user_id, amount, merchant_name, upi_id, transaction_ref, otp_code_hash, otp_phone, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        booking.booking_id,
        userId,
        booking.total_price,
        UPI_MERCHANT_NAME,
        UPI_ID,
        transactionRef,
        '',
        booking.passenger_phone,
        transactionStatus,
        expiresAt
      ]
    );

    await connection.commit();

    return res.json({
      ok: true,
      bookingId: booking.booking_id,
      reservationId: booking.reservation_id,
      merchantName: UPI_MERCHANT_NAME,
      amount: Number(booking.total_price),
      upiId: UPI_ID,
      walletBalance,
      transactionRef,
      requiresOtp: false,
      otpPhone: booking.passenger_phone,
      expiresAt: expiresAt.toISOString(),
      qrPayload: `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(UPI_MERCHANT_NAME)}&am=${Number(booking.total_price).toFixed(2)}&tn=${encodeURIComponent(booking.reservation_id)}&tr=${encodeURIComponent(transactionRef)}`
    });
  } catch (err) {
    await connection.rollback();
    console.error('Initiate UPI payment error:', err);
    return res.status(500).json({ ok: false, error: 'Could not start the UPI payment flow.' });
  } finally {
    connection.release();
  }
}

async function confirmUpiPayment(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.body.bookingId);
  const loginPassword = req.body.loginPassword;
  const userId = req.session.user.user_id;

  if (!bookingId) {
    return res.status(400).json({ ok: false, error: 'Booking ID is required.' });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await ensureWalletForUser(connection, userId);

    const [bookingRows] = await connection.query(
      'SELECT * FROM bookings WHERE booking_id = ? AND user_id = ? FOR UPDATE',
      [bookingId, userId]
    );

    if (!bookingRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, error: 'Booking not found.' });
    }

    const booking = bookingRows[0];

    if (booking.booking_status !== 'PENDING_PAYMENT') {
      await connection.rollback();
      return res.status(400).json({ ok: false, error: 'Booking payment is already completed.' });
    }

    const passwordCheck = await verifyPaymentPassword(connection, booking, userId, loginPassword);
    if (!passwordCheck.ok) {
      await connection.commit();
      return res.status(passwordCheck.bookingCancelled ? 403 : 400).json({
        ok: false,
        error: passwordCheck.message,
        attemptsRemaining: passwordCheck.attemptsRemaining,
        bookingCancelled: Boolean(passwordCheck.bookingCancelled),
        redirectTo: passwordCheck.bookingCancelled ? '/dashboard' : null
      });
    }

    await expireStaleTransactions(connection, bookingId, userId);
    const transaction = await findPendingTransaction(connection, bookingId, userId);
    if (!transaction) {
      await connection.rollback();
      return res.status(400).json({ ok: false, error: 'No active UPI transaction found. Start payment again.' });
    }

    if (new Date(transaction.expires_at) <= new Date()) {
      await connection.query('UPDATE transactions SET status = ? WHERE transaction_id = ?', ['EXPIRED', transaction.transaction_id]);
      await connection.rollback();
      return res.status(400).json({ ok: false, error: 'UPI session expired. Please restart the payment.' });
    }

    await finalizeBookingPayment(connection, booking, transaction.transaction_ref, 'UPI');
    await connection.query(
      'UPDATE transactions SET status = ?, verified_at = NOW() WHERE transaction_id = ?',
      ['SUCCESS', transaction.transaction_id]
    );

    await connection.commit();

    const bookingMessageData = await getBookingMessagingData(userId, booking.booking_id);
    const wallet = await getWalletSummary(userId);
    if (bookingMessageData) {
      await sendPaymentLifecycleSms(req, bookingMessageData, wallet.balance);
    }

    return res.json({
      ok: true,
      bookingId: booking.booking_id,
      reservationId: booking.reservation_id,
      amount: Number(booking.total_price),
      transactionRef: transaction.transaction_ref,
      paidAt: getFormattedTimestamp(),
      walletBalance: Number(wallet.balance)
    });
  } catch (err) {
    await connection.rollback();
    console.error('Confirm UPI payment error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not complete payment.' });
  } finally {
    connection.release();
  }
}

async function verifyUpiOtp(req, res) {
  await ensureBookingSchema();
  return res.status(400).json({ ok: false, error: 'OTP verification is disabled for payment.' });
}

async function getWalletBalanceApi(req, res) {
  await ensureBookingSchema();

  const wallet = await getWalletSummary(req.session.user.user_id);
  res.json({ ok: true, balance: Number(wallet.balance), updatedAt: wallet.updated_at });
}

async function getBookingHistoryApi(req, res) {
  await ensureBookingSchema();

  const bookings = await getBookingHistoryRows(req.session.user.user_id);
  res.json({ ok: true, bookings });
}

async function getBookingReceiptApi(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.params.bookingId);
  const receipt = await getBookingReceiptData(req.session.user.user_id, bookingId);

  if (!receipt) {
    return res.status(404).json({ ok: false, error: 'Booking receipt not found.' });
  }

  const units = await getBookingUnits(bookingId);
  res.json({ ok: true, receipt, units });
}

async function renderBookingHistoryPage(req, res) {
  await ensureBookingSchema();

  const userId = req.session.user.user_id;
  const bookings = await getBookingHistoryRows(userId);
  const wallet = await getWalletSummary(userId);

  res.render('booking/history', { bookings, wallet });
}

async function renderBookingReceiptPage(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.params.bookingId);
  const userId = req.session.user.user_id;
  const booking = await getBookingReceiptData(userId, bookingId);

  if (!booking) {
    return res.status(404).send('Booking receipt not found');
  }

  const units = await getBookingUnits(bookingId);
  res.render('booking/receipt', { booking, units });
}

async function confirmPayment(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.params.bookingId);
  const userId = req.session.user.user_id;
  const { method, loginPassword } = req.body;

  if (!VALID_PAYMENT_METHODS.has(method)) {
    req.flash('error', 'Invalid payment method selected.');
    return res.redirect(`/booking/payment/${bookingId}`);
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [bookingRows] = await connection.query(
      'SELECT * FROM bookings WHERE booking_id = ? AND user_id = ? FOR UPDATE',
      [bookingId, userId]
    );

    if (!bookingRows.length) {
      await connection.rollback();
      return res.status(404).send('Booking not found');
    }

    const booking = bookingRows[0];

    if (booking.booking_status !== 'PENDING_PAYMENT') {
      await connection.rollback();
      req.flash('error', 'This booking is already processed.');
      return res.redirect('/dashboard');
    }

    const passwordCheck = await verifyPaymentPassword(connection, booking, userId, loginPassword);
    if (!passwordCheck.ok) {
      await connection.commit();
      req.flash('error', passwordCheck.message);
      return res.redirect(passwordCheck.bookingCancelled ? '/dashboard' : `/booking/payment/${bookingId}`);
    }

    const transactionRef = generateTransactionRef();
    await finalizeBookingPayment(connection, booking, transactionRef, method);

    await connection.commit();

    const bookingMessageData = await getBookingMessagingData(userId, booking.booking_id);
    const wallet = await getWalletSummary(userId);
    if (bookingMessageData) {
      await sendPaymentLifecycleSms(req, bookingMessageData, wallet.balance);
    }

    req.flash('success', 'Payment successful and booking confirmed.');
    res.render('booking/payment-success', {
      bookingId,
      reservationId: booking.reservation_id,
      amount: booking.total_price,
      transactionRef,
      paidAt: getFormattedTimestamp()
    });
  } catch (err) {
    await connection.rollback();
    console.error('Payment error:', err);
    req.flash('error', 'Payment failed due to server issue. Try again.');
    res.redirect(`/booking/payment/${bookingId}`);
  } finally {
    connection.release();
  }
}

async function cancelReservation(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.params.bookingId);
  const userId = req.session.user.user_id;

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    let refundAmount = null;

    const [rows] = await connection.query(
      'SELECT * FROM bookings WHERE booking_id = ? AND user_id = ? FOR UPDATE',
      [bookingId, userId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).send('Booking not found');
    }

    const booking = rows[0];

    if (booking.booking_status === 'CANCELLED') {
      await connection.rollback();
      req.flash('error', 'Booking already cancelled.');
      return res.redirect('/dashboard');
    }

    await connection.query('UPDATE bookings SET booking_status = ? WHERE booking_id = ?', ['CANCELLED', bookingId]);
    await clearSeatHold(connection, bookingId);

    if (booking.booking_status === 'CONFIRMED') {
      const config = getInventoryConfig(booking.booking_type);
      if (config) {
        await connection.query(
          `UPDATE ${config.table} SET ${config.availabilityCol} = ${config.availabilityCol} + ? WHERE ${config.id} = ?`,
          [booking.units, booking.reference_id]
        );
      }

      const [unitRows] = await connection.query('SELECT seat_label FROM booking_seats WHERE booking_id = ?', [bookingId]);
      if (unitRows.length) {
        const labels = unitRows.map((row) => row.seat_label);
        await connection.query(
          'UPDATE seats_rooms SET status = ? WHERE inventory_type = ? AND inventory_id = ? AND label IN (?)',
          ['AVAILABLE', booking.booking_type, booking.reference_id, labels]
        );
      }
    }

    const [paymentRows] = await connection.query(
      "SELECT * FROM payments WHERE booking_id = ? AND payment_status = 'SUCCESS' ORDER BY payment_id DESC LIMIT 1",
      [bookingId]
    );

    if (paymentRows.length) {
      const payment = paymentRows[0];
      const [refundRows] = await connection.query('SELECT refund_id FROM refunds WHERE payment_id = ? LIMIT 1', [payment.payment_id]);

      if (!refundRows.length) {
        refundAmount = Number(payment.amount) * 0.9;
        await ensureWalletForUser(connection, booking.user_id);
        if (payment.payment_method === 'UPI') {
          await connection.query('UPDATE wallet SET balance = balance + ? WHERE user_id = ?', [refundAmount, booking.user_id]);
        }
        await connection.query(
          'INSERT INTO refunds (payment_id, refund_amount, refund_status) VALUES (?, ?, ?)',
          [payment.payment_id, refundAmount, 'PROCESSED']
        );
      }
    }

    await connection.query(
      'INSERT INTO notifications (user_id, title, message, channel) VALUES (?, ?, ?, ?)',
      [booking.user_id, 'Booking Cancelled', `Your booking ${booking.reservation_id} has been cancelled.`, 'email']
    );

    await connection.commit();
    const bookingMessageData = await getBookingMessagingData(userId, bookingId);
    if (bookingMessageData) {
      await sendCancellationSms(req, bookingMessageData, refundAmount);
    }

    req.flash('success', 'Booking cancelled successfully. Refund initiated where applicable.');
    res.redirect('/dashboard');
  } catch (err) {
    await connection.rollback();
    console.error('Cancellation error:', err);
    req.flash('error', 'Could not cancel booking at this time.');
    res.redirect('/dashboard');
  } finally {
    connection.release();
  }
}

async function downloadReservationTicket(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.params.bookingId);
  const userId = req.session.user.user_id;

  const [rows] = await pool.query(
    `SELECT b.*, 
            (SELECT p.transaction_ref FROM payments p WHERE p.booking_id = b.booking_id ORDER BY p.payment_id DESC LIMIT 1) AS transaction_ref
     FROM bookings b
     WHERE b.booking_id = ? AND b.user_id = ?`,
    [bookingId, userId]
  );

  if (!rows.length) return res.status(404).send('Ticket not found');

  const b = rows[0];

  if (b.booking_status !== 'CONFIRMED') {
    req.flash('error', 'Only confirmed bookings can be downloaded as tickets.');
    return res.redirect('/dashboard');
  }

  const [seatRows] = await pool.query('SELECT seat_label FROM booking_seats WHERE booking_id = ? ORDER BY seat_label', [bookingId]);
  const labels = seatRows.map((row) => row.seat_label).join(', ');
  const unitTitle = b.booking_type === 'hotel' ? 'Rooms' : 'Seats';

  const text = [
    'ONLINE RESERVATION SYSTEM (ORS) - E-TICKET',
    `Reservation ID: ${b.reservation_id}`,
    `Booking Type: ${b.booking_type.toUpperCase()}`,
    `Passenger: ${b.passenger_name}`,
    `Gender: ${b.passenger_gender || 'N/A'}`,
    `Email: ${b.passenger_email}`,
    `Phone: ${b.passenger_phone}`,
    `${unitTitle}: ${labels || b.units}`,
    `Travel Date: ${b.travel_date}`,
    ...(b.booking_type === 'hotel' && b.check_out_date ? [`Check-out Date: ${b.check_out_date}`] : []),
    `Total Paid: INR ${b.total_price}`,
    `Transaction Ref: ${b.transaction_ref || 'N/A'}`,
    `Booking Status: ${b.booking_status}`
  ].join('\n');

  res.setHeader('Content-Disposition', `attachment; filename=ticket-${b.reservation_id}.txt`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(text);
}

async function renderPrintableTicketPage(req, res) {
  await ensureBookingSchema();

  const bookingId = Number(req.params.bookingId);
  const userId = req.session.user.user_id;
  const booking = await getBookingMessagingData(userId, bookingId);

  if (!booking) {
    return res.status(404).send('Ticket not found');
  }

  if (booking.booking_status !== 'CONFIRMED') {
    req.flash('error', 'Only confirmed bookings can be viewed as tickets.');
    return res.redirect('/dashboard');
  }

  const qrPayload = JSON.stringify({
    reservationId: booking.reservation_id,
    bookingType: booking.booking_type,
    model: getDisplayModelName(booking),
    route: booking.route_label,
    travelDate: booking.travel_date,
    units: booking.unit_labels || booking.units,
    transactionRef: booking.transaction_ref || 'N/A'
  });

  res.render('booking/print-ticket', {
    booking,
    qrPayload,
    modelName: getDisplayModelName(booking)
  });
}

module.exports = {
  renderUserDashboard,
  fetchSeatMap,
  renderBookingPage,
  createReservation,
  renderPaymentPage,
  initiateUpiPayment,
  confirmUpiPayment,
  verifyUpiOtp,
  getWalletBalanceApi,
  getBookingHistoryApi,
  getBookingReceiptApi,
  renderBookingHistoryPage,
  renderBookingReceiptPage,
  confirmPayment,
  cancelReservation,
  downloadReservationTicket,
  renderPrintableTicketPage
};
