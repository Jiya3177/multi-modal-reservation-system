const pool = require('../config/db');
const { getLocalDateString } = require('../utils/dateTime');

const VALID_TYPES = new Set(['flight', 'train', 'bus', 'hotel']);
const TRANSPORT_TABLE_BY_TYPE = { flight: 'flights', train: 'trains', bus: 'buses' };

function buildSearchMeta(mode, note) {
  return { mode, note };
}

async function fetchCitySuggestions(req, res) {
  const searchTerm = (req.query.q || '').trim();
  if (!searchTerm) return res.json([]);

  const [rows] = await pool.query(
    'SELECT city_name FROM cities WHERE city_name LIKE ? ORDER BY city_name LIMIT 8',
    [`%${searchTerm}%`]
  );

  res.json(rows.map((r) => r.city_name));
}

async function findCityByName(cityName) {
  const normalizedCityName = String(cityName || '').trim().toLowerCase();
  if (!normalizedCityName) return null;

  const [rows] = await pool.query(
    'SELECT city_id, city_name FROM cities WHERE LOWER(TRIM(city_name)) = ? LIMIT 1',
    [normalizedCityName]
  );

  return rows[0] || null;
}

async function findHotelResults({ cityId, maxPrice, minRating, roomsNeeded, classType }) {

  let query = `
    SELECT h.*, c.city_name
    FROM hotels h
    JOIN cities c ON c.city_id = h.city_id
    WHERE h.city_id = ?
      AND h.price_per_night <= ?
      AND h.rating >= ?
      AND h.available_rooms >= ?
  `;

  const params = [cityId, maxPrice, minRating, roomsNeeded];

  if (classType) {
    query += ' AND h.room_type LIKE ?';
    params.push(`%${classType}%`);
  }

  query += ' ORDER BY h.rating DESC, h.price_per_night ASC LIMIT 40';

  const [results] = await pool.query(query, params);
  return results;
}

async function findTransportResults({
  table,
  sourceCityId,
  destinationCityId,
  searchDate,
  maxPrice,
  minRating,
  peopleCount,
  classType,
  dateMode
}) {
  let query = `
    SELECT t.*, s.city_name AS source_city, d.city_name AS destination_city,
           ABS(DATEDIFF(t.travel_date, ?)) AS date_diff
    FROM ${table} t
    JOIN cities s ON s.city_id = t.source_city_id
    JOIN cities d ON d.city_id = t.destination_city_id
    WHERE t.price <= ?
      AND t.rating >= ?
      AND t.available_seats >= ?
  `;

  const params = [searchDate, maxPrice, minRating, peopleCount];

  query += ' AND t.source_city_id = ? AND t.destination_city_id = ?';
  params.push(sourceCityId, destinationCityId);

  if (dateMode === 'tight') {
    query += ' AND t.travel_date BETWEEN ? AND DATE_ADD(?, INTERVAL 14 DAY)';
    params.push(searchDate, searchDate);
  } else if (dateMode === 'wide') {
    query += ' AND t.travel_date BETWEEN DATE_SUB(?, INTERVAL 30 DAY) AND DATE_ADD(?, INTERVAL 180 DAY)';
    params.push(searchDate, searchDate);
  } else if (dateMode === 'upcoming') {
    query += ' AND t.travel_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 365 DAY)';
  }

  if (classType) {
    query += ' AND t.class_type LIKE ?';
    params.push(`%${classType}%`);
  }

  query += ' ORDER BY date_diff ASC, t.price ASC, t.rating DESC LIMIT 50';

  const [results] = await pool.query(query, params);
  return results;
}

async function searchInventory(req, res) {
  const { type, source, destination, date, checkOutDate, maxPrice, classType, people, minRating } = req.body;
  const today = getLocalDateString();

  if (!VALID_TYPES.has(type)) {
    return res.status(400).send('Invalid search type.');
  }

  const peopleCount = Math.max(1, Number(people) || 1);
  const maxPriceVal = Number(maxPrice) > 0 ? Number(maxPrice) : 100000;
  const minRatingVal = Number(minRating) >= 0 ? Number(minRating) : 0;
  const searchDate = date || getLocalDateString();

  let results = [];
  let searchMeta = buildSearchMeta('strict', 'Showing best matches for your filters.');

  if (type === 'hotel') {
    const city = (destination || '').trim();
    if (!city) return res.status(400).send('Please enter hotel city.');
    if (!date || !checkOutDate) {
      return res.status(400).send('Please enter hotel check-in and check-out dates.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOutDate)) {
      return res.status(400).send('Please enter valid hotel stay dates.');
    }
    if (date < today) {
      return res.status(400).send('Hotel check-in date cannot be in the past.');
    }

    const checkInDate = new Date(`${date}T00:00:00`);
    const checkOutDateValue = new Date(`${checkOutDate}T00:00:00`);
    if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDateValue.getTime()) || checkOutDateValue <= checkInDate) {
      return res.status(400).send('Hotel check-out date must be after check-in date.');
    }

    const hotelCity = await findCityByName(city);

    if (!hotelCity) {
      return res.render('search/results', {
        type,
        results: [],
        filters: req.body,
        searchMeta: buildSearchMeta('no-match', 'Selected city was not found. Please choose a valid city from the available destinations.')
      });
    }

    const roomsNeeded = Math.max(1, Math.ceil(peopleCount / 2));

    results = await findHotelResults({
      cityId: hotelCity.city_id,
      maxPrice: maxPriceVal,
      minRating: minRatingVal,
      roomsNeeded,
      classType
    });

    if (!results.length) {
      results = await findHotelResults({
        cityId: hotelCity.city_id,
        maxPrice: maxPriceVal * 2,
        minRating: 0,
        roomsNeeded,
        classType: ''
      });

      if (results.length) {
        searchMeta = buildSearchMeta('relaxed', 'No exact hotel matches found. Showing nearby price/rating alternatives in the same city.');
      }
    }

    if (!results.length) {
      const [[hotelCount]] = await pool.query('SELECT COUNT(*) AS total FROM hotels');
      searchMeta = hotelCount.total === 0
        ? buildSearchMeta('no-inventory', 'No hotel inventory is configured yet. Add hotels from Admin panel.')
        : buildSearchMeta('no-match', `No hotels are available for ${hotelCity.city_name} with the selected filters. Try another date, class, or budget.`);
    }

    return res.render('search/results', { type, results, filters: req.body, searchMeta });
  }

  const src = (source || '').trim();
  const dest = (destination || '').trim();
  if (!src || !dest) return res.status(400).send('Please enter source and destination city.');
  if (!date) return res.status(400).send('Please select a travel date.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).send('Please enter a valid travel date.');
  }
  if (date < today) {
    return res.status(400).send('Travel date cannot be in the past.');
  }
  if (src.toLowerCase() === dest.toLowerCase()) {
    return res.status(400).send('Source and destination city cannot be the same.');
  }
  const sourceCity = await findCityByName(src);
  const destinationCity = await findCityByName(dest);

  if (!sourceCity || !destinationCity) {
    return res.render('search/results', {
      type,
      results: [],
      filters: req.body,
      searchMeta: buildSearchMeta('no-match', 'Source or destination city was not found. Please select valid cities from the available destinations.')
    });
  }

  const table = TRANSPORT_TABLE_BY_TYPE[type];

  results = await findTransportResults({
    table,
    sourceCityId: sourceCity.city_id,
    destinationCityId: destinationCity.city_id,
    searchDate,
    maxPrice: maxPriceVal,
    minRating: minRatingVal,
    peopleCount,
    classType,
    dateMode: 'tight'
  });

  if (!results.length) {
    results = await findTransportResults({
      table,
      sourceCityId: sourceCity.city_id,
      destinationCityId: destinationCity.city_id,
      searchDate,
      maxPrice: maxPriceVal * 2,
      minRating: Math.min(minRatingVal, 3),
      peopleCount,
      classType: '',
      dateMode: 'wide'
    });

    if (results.length) {
      searchMeta = buildSearchMeta('relaxed', 'No exact date/class matches found. Showing closest dates and fare alternatives.');
    }
  }

  if (!results.length) {
    const [[tableCount]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    searchMeta = tableCount.total === 0
      ? buildSearchMeta('no-inventory', `No ${type} inventory is configured yet. Add records from Admin panel.`)
      : buildSearchMeta('no-match', `No ${type} service is available from ${sourceCity.city_name} to ${destinationCity.city_name} for the selected filters.`);
  }

  res.render('search/results', { type, results, filters: req.body, searchMeta });
}

module.exports = { searchInventory, fetchCitySuggestions };
