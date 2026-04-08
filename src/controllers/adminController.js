const pool = require('../config/db');
const { getLocalDateString } = require('../utils/dateTime');

const tableByType = {
  flight: { table: 'flights', id: 'flight_id', title: 'Flights' },
  train: { table: 'trains', id: 'train_id', title: 'Trains' },
  bus: { table: 'buses', id: 'bus_id', title: 'Buses' },
  hotel: { table: 'hotels', id: 'hotel_id', title: 'Hotels' }
};

function normalizeText(value) {
  return String(value || '').trim();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateTransportInventory(body) {
  const code = normalizeText(body.code);
  const operatorName = normalizeText(body.operator_name);
  const classType = normalizeText(body.class_type);
  const sourceCityId = Number(body.source_city_id);
  const destinationCityId = Number(body.destination_city_id);
  const travelDate = normalizeText(body.travel_date);
  const departTime = normalizeText(body.depart_time);
  const arriveTime = normalizeText(body.arrive_time);
  const price = toNumber(body.price);
  const totalSeats = toNumber(body.total_seats);
  const availableSeats = toNumber(body.available_seats);
  const rating = body.rating === '' || body.rating == null ? 4 : toNumber(body.rating);

  if (!code || !operatorName || !classType || !travelDate || !departTime || !arriveTime) {
    return { error: 'All transport fields are required.' };
  }

  if (!Number.isInteger(sourceCityId) || !Number.isInteger(destinationCityId) || sourceCityId <= 0 || destinationCityId <= 0) {
    return { error: 'Please select valid source and destination cities.' };
  }

  if (sourceCityId === destinationCityId) {
    return { error: 'Source and destination cannot be the same.' };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate) || travelDate < getLocalDateString()) {
    return { error: 'Travel date must be today or a future date.' };
  }

  if (!/^\d{2}:\d{2}$/.test(departTime) || !/^\d{2}:\d{2}$/.test(arriveTime)) {
    return { error: 'Enter valid departure and arrival times.' };
  }

  if (price == null || price <= 0 || totalSeats == null || totalSeats < 1 || availableSeats == null || availableSeats < 0) {
    return { error: 'Price and seat counts must be valid positive numbers.' };
  }

  if (availableSeats > totalSeats) {
    return { error: 'Available seats cannot exceed total seats.' };
  }

  if (rating == null || rating < 0 || rating > 5) {
    return { error: 'Rating must be between 0 and 5.' };
  }

  return {
    value: {
      code,
      operator_name: operatorName,
      source_city_id: sourceCityId,
      destination_city_id: destinationCityId,
      travel_date: travelDate,
      depart_time: departTime,
      arrive_time: arriveTime,
      class_type: classType,
      price,
      total_seats: totalSeats,
      available_seats: availableSeats,
      rating
    }
  };
}

function validateHotelInventory(body) {
  const hotelName = normalizeText(body.hotel_name);
  const roomType = normalizeText(body.room_type);
  const amenities = normalizeText(body.amenities);
  const cityId = Number(body.city_id);
  const pricePerNight = toNumber(body.price_per_night);
  const totalRooms = toNumber(body.total_rooms);
  const availableRooms = toNumber(body.available_rooms);
  const rating = body.rating === '' || body.rating == null ? 4 : toNumber(body.rating);

  if (!hotelName || !roomType || !amenities) {
    return { error: 'Hotel name, room type, and amenities are required.' };
  }

  if (!Number.isInteger(cityId) || cityId <= 0) {
    return { error: 'Please select a valid hotel city.' };
  }

  if (pricePerNight == null || pricePerNight <= 0 || totalRooms == null || totalRooms < 1 || availableRooms == null || availableRooms < 0) {
    return { error: 'Price and room counts must be valid positive numbers.' };
  }

  if (availableRooms > totalRooms) {
    return { error: 'Available rooms cannot exceed total rooms.' };
  }

  if (rating == null || rating < 0 || rating > 5) {
    return { error: 'Rating must be between 0 and 5.' };
  }

  return {
    value: {
      hotel_name: hotelName,
      city_id: cityId,
      room_type: roomType,
      amenities,
      price_per_night: pricePerNight,
      total_rooms: totalRooms,
      available_rooms: availableRooms,
      rating
    }
  };
}

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

  await pool.query(`
    INSERT INTO wallet (user_id, balance)
    SELECT u.user_id, 50000
    FROM users u
    LEFT JOIN wallet w ON w.user_id = u.user_id
    WHERE w.user_id IS NULL
  `);
}

async function getAdminDashboard(req, res) {
  await ensureWalletTable();

  const [[users]] = await pool.query('SELECT COUNT(*) AS total_users FROM users');
  const [[bookings]] = await pool.query('SELECT COUNT(*) AS total_bookings FROM bookings');
  const [[revenue]] = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total_revenue FROM payments WHERE payment_status = 'SUCCESS'");
  const [[walletBalance]] = await pool.query('SELECT COALESCE(SUM(balance), 0) AS total_wallet_balance FROM wallet');
  const [bookingStats] = await pool.query('SELECT booking_type, COUNT(*) AS count FROM bookings GROUP BY booking_type');

  res.render('admin/dashboard', { users, bookings, revenue, walletBalance, bookingStats });
}

async function manageInventory(req, res) {
  const { type } = req.params;
  const config = tableByType[type];
  if (!config) return res.status(400).send('Invalid type');

  const [items] = await pool.query(`SELECT * FROM ${config.table} ORDER BY ${config.id} DESC`);
  const [cities] = await pool.query('SELECT city_id, city_name FROM cities ORDER BY city_name');

  res.render('admin/manage-inventory', { type, config, items, cities, error: null });
}

async function addInventory(req, res) {
  const { type } = req.params;
  const config = tableByType[type];
  if (!config) return res.status(400).send('Invalid type');

  try {
    if (type === 'hotel') {
      const { error, value } = validateHotelInventory(req.body);
      if (error) throw new Error(error);
      await pool.query(
        `INSERT INTO hotels (hotel_name, city_id, room_type, amenities, price_per_night, total_rooms, available_rooms, rating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [value.hotel_name, value.city_id, value.room_type, value.amenities, value.price_per_night, value.total_rooms, value.available_rooms, value.rating]
      );
    } else {
      const { error, value } = validateTransportInventory(req.body);
      if (error) throw new Error(error);
      await pool.query(
        `INSERT INTO ${config.table} (code, operator_name, source_city_id, destination_city_id, travel_date, depart_time, arrive_time, class_type, price, total_seats, available_seats, rating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [value.code, value.operator_name, value.source_city_id, value.destination_city_id, value.travel_date, value.depart_time, value.arrive_time, value.class_type, value.price, value.total_seats, value.available_seats, value.rating]
      );
    }

    req.flash('success', `${config.title.slice(0, -1)} added successfully.`);
  } catch (err) {
    req.flash('error', `Error adding record: ${err.message}`);
  }

  res.redirect(`/admin/manage/${type}`);
}

async function getEditInventory(req, res) {
  const { type, id } = req.params;
  const config = tableByType[type];
  if (!config) return res.status(400).send('Invalid type');

  const [rows] = await pool.query(`SELECT * FROM ${config.table} WHERE ${config.id} = ?`, [id]);
  if (!rows.length) return res.status(404).send('Record not found');

  const [cities] = await pool.query('SELECT city_id, city_name FROM cities ORDER BY city_name');
  res.render('admin/edit-inventory', { type, config, item: rows[0], cities });
}

async function updateInventory(req, res) {
  const { type, id } = req.params;
  const config = tableByType[type];
  if (!config) return res.status(400).send('Invalid type');

  try {
    if (type === 'hotel') {
      const { error, value } = validateHotelInventory(req.body);
      if (error) throw new Error(error);
      await pool.query(
        `UPDATE hotels
         SET hotel_name = ?, city_id = ?, room_type = ?, amenities = ?, price_per_night = ?, total_rooms = ?, available_rooms = ?, rating = ?
         WHERE hotel_id = ?`,
        [value.hotel_name, value.city_id, value.room_type, value.amenities, value.price_per_night, value.total_rooms, value.available_rooms, value.rating, id]
      );
    } else {
      const { error, value } = validateTransportInventory(req.body);
      if (error) throw new Error(error);
      await pool.query(
        `UPDATE ${config.table}
         SET code = ?, operator_name = ?, source_city_id = ?, destination_city_id = ?, travel_date = ?, depart_time = ?, arrive_time = ?,
             class_type = ?, price = ?, total_seats = ?, available_seats = ?, rating = ?
         WHERE ${config.id} = ?`,
        [value.code, value.operator_name, value.source_city_id, value.destination_city_id, value.travel_date, value.depart_time, value.arrive_time, value.class_type, value.price, value.total_seats, value.available_seats, value.rating, id]
      );
    }

    req.flash('success', 'Record updated successfully.');
  } catch (err) {
    req.flash('error', `Error updating record: ${err.message}`);
  }

  res.redirect(`/admin/manage/${type}`);
}

async function deleteInventory(req, res) {
  const { type, id } = req.params;
  const config = tableByType[type];
  if (!config) return res.status(400).send('Invalid type');

  try {
    await pool.query(`DELETE FROM ${config.table} WHERE ${config.id} = ?`, [id]);
    req.flash('success', 'Record deleted.');
  } catch (err) {
    req.flash('error', `Delete failed: ${err.message}`);
  }

  res.redirect(`/admin/manage/${type}`);
}

async function getUsers(req, res) {
  await ensureWalletTable();

  const [users] = await pool.query(
    `SELECT u.user_id, u.full_name, u.email, u.phone, u.role, u.created_at,
            COALESCE(w.balance, 50000) AS wallet_balance,
            (
              SELECT COUNT(*)
              FROM bookings b
              WHERE b.user_id = u.user_id
            ) AS booking_count,
            (
              SELECT COALESCE(SUM(p.amount), 0)
              FROM payments p
              JOIN bookings b ON b.booking_id = p.booking_id
              WHERE b.user_id = u.user_id
                AND p.payment_status = 'SUCCESS'
            ) AS total_spent
     FROM users u
     LEFT JOIN wallet w ON w.user_id = u.user_id
     ORDER BY u.user_id DESC`
  );

  res.render('admin/users', { users });
}

async function getUserDetail(req, res) {
  await ensureWalletTable();

  const userId = Number(req.params.id);
  const [[user]] = await pool.query(
    `SELECT u.user_id, u.full_name, u.email, u.phone, u.role, u.created_at,
            COALESCE(w.balance, 50000) AS wallet_balance,
            w.updated_at AS wallet_updated_at
     FROM users u
     LEFT JOIN wallet w ON w.user_id = u.user_id
     WHERE u.user_id = ?`,
    [userId]
  );

  if (!user) {
    return res.status(404).send('User not found');
  }

  const [bookings] = await pool.query(
    `SELECT b.booking_id, b.reservation_id, b.booking_type, b.total_price, b.booking_status, b.travel_date, b.check_out_date, b.created_at,
            COALESCE(p.payment_status, 'PENDING') AS payment_status,
            p.transaction_ref
     FROM bookings b
     LEFT JOIN (
       SELECT p1.*
       FROM payments p1
       JOIN (
         SELECT booking_id, MAX(payment_id) AS latest_id
         FROM payments
         GROUP BY booking_id
       ) latest_payment ON latest_payment.latest_id = p1.payment_id
     ) p ON p.booking_id = b.booking_id
     WHERE b.user_id = ?
     ORDER BY b.booking_id DESC`,
    [userId]
  );

  const [[summary]] = await pool.query(
    `SELECT COUNT(*) AS total_bookings,
            COALESCE(SUM(CASE WHEN booking_status = 'CONFIRMED' THEN total_price ELSE 0 END), 0) AS confirmed_value
     FROM bookings
     WHERE user_id = ?`,
    [userId]
  );

  res.render('admin/user-detail', { user, bookings, summary });
}

async function addWalletFunds(req, res) {
  await ensureWalletTable();

  const userId = Number(req.params.id);
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash('error', 'Enter a valid wallet top-up amount.');
    return res.redirect(`/admin/users/${userId}`);
  }

  try {
    const [result] = await pool.query('UPDATE wallet SET balance = balance + ? WHERE user_id = ?', [amount, userId]);

    if (!result.affectedRows) {
      req.flash('error', 'User wallet not found.');
      return res.redirect('/admin/users');
    }

    req.flash('success', `Wallet updated successfully. INR ${amount.toFixed(2)} added.`);
  } catch (err) {
    req.flash('error', `Wallet update failed: ${err.message}`);
  }

  res.redirect(`/admin/users/${userId}`);
}

async function deleteUser(req, res) {
  const userId = Number(req.params.id);

  try {
    await pool.query('DELETE FROM users WHERE user_id = ?', [userId]);
    req.flash('success', 'User deleted successfully.');
  } catch (err) {
    req.flash('error', 'Cannot delete user with existing booking records.');
  }

  res.redirect('/admin/users');
}

async function getBookings(req, res) {
  const [bookings] = await pool.query(
    `SELECT b.booking_id, b.reservation_id, b.booking_type, b.total_price, b.booking_status, b.travel_date, b.created_at,
            u.full_name, u.email,
            (SELECT p.payment_status FROM payments p WHERE p.booking_id = b.booking_id ORDER BY p.payment_id DESC LIMIT 1) AS payment_status
     FROM bookings b
     JOIN users u ON u.user_id = b.user_id
     ORDER BY b.booking_id DESC`
  );

  res.render('admin/bookings', { bookings });
}

async function getPayments(req, res) {
  const [payments] = await pool.query(
    `SELECT p.payment_id, p.booking_id, p.amount, p.payment_method, p.transaction_ref, p.payment_status, p.created_at,
            b.reservation_id, b.booking_type, u.full_name,
            r.refund_amount, r.refund_status
     FROM payments p
     JOIN bookings b ON b.booking_id = p.booking_id
     JOIN users u ON u.user_id = b.user_id
     LEFT JOIN refunds r ON r.payment_id = p.payment_id
     ORDER BY p.payment_id DESC`
  );

  res.render('admin/payments', { payments });
}

module.exports = {
  getAdminDashboard,
  manageInventory,
  addInventory,
  getEditInventory,
  updateInventory,
  deleteInventory,
  getUsers,
  getUserDetail,
  addWalletFunds,
  deleteUser,
  getBookings,
  getPayments
};
