const pool = require('../config/db');
const { getLocalDateString } = require('./dateTime');

const TRANSPORT_CONFIG = {
  flight: {
    table: 'flights',
    codePrefix: 'FL',
    operatorName: 'ORS Airways',
    classType: 'Economy',
    priceBase: 4200,
    totalSeats: 180,
    availableSeats: 96,
    rating: 4.3,
    departureHour: 8,
    durationHours: 2
  },
  train: {
    table: 'trains',
    codePrefix: 'TR',
    operatorName: 'ORS Rail',
    classType: '3AC',
    priceBase: 1600,
    totalSeats: 720,
    availableSeats: 340,
    rating: 4.2,
    departureHour: 6,
    durationHours: 10
  },
  bus: {
    table: 'buses',
    codePrefix: 'BS',
    operatorName: 'ORS Roadways',
    classType: 'AC Sleeper',
    priceBase: 1100,
    totalSeats: 42,
    availableSeats: 19,
    rating: 4.1,
    departureHour: 21,
    durationHours: 8
  }
};

const HOTEL_VARIANTS = [
  {
    suffix: 'Central Stay',
    roomType: 'Standard',
    amenities: 'WiFi,Breakfast,Housekeeping',
    pricePerNight: 2400,
    totalRooms: 90,
    availableRooms: 34,
    rating: 4.1
  },
  {
    suffix: 'Grand Suites',
    roomType: 'Deluxe',
    amenities: 'WiFi,Pool,Breakfast,Gym',
    pricePerNight: 3600,
    totalRooms: 75,
    availableRooms: 28,
    rating: 4.4
  },
  {
    suffix: 'Skyline Residency',
    roomType: 'Suite',
    amenities: 'WiFi,Gym,Airport Shuttle,Breakfast',
    pricePerNight: 4800,
    totalRooms: 60,
    availableRooms: 22,
    rating: 4.6
  }
];

const DAY_OFFSETS = [2, 10, 25, 45, 75, 120];

function formatDate(date) {
  return getLocalDateString(date);
}

function formatTime(totalHours) {
  const hours = ((Math.floor(totalHours) % 24) + 24) % 24;
  const minutes = Math.round((totalHours - Math.floor(totalHours)) * 60) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
}

function buildTransportCode(codePrefix, sourceCityId, destinationCityId, dayOffset) {
  return `${codePrefix}${sourceCityId}${destinationCityId}${String(dayOffset).padStart(3, '0')}`;
}

function buildTransportRecord(transportType, sourceCity, destinationCity, dayOffset) {
  const config = TRANSPORT_CONFIG[transportType];
  const travelDate = new Date();
  travelDate.setDate(travelDate.getDate() + dayOffset);

  const routeWeight = Math.abs(destinationCity.city_id - sourceCity.city_id) + 1;
  const departureHour = config.departureHour + (routeWeight % 5);
  const durationHours = config.durationHours + routeWeight * (transportType === 'flight' ? 0.25 : transportType === 'train' ? 0.8 : 0.5);
  const dynamicPrice = config.priceBase + routeWeight * (transportType === 'flight' ? 450 : transportType === 'train' ? 180 : 120) + dayOffset * 4;
  const reservedUnits = Math.max(2, Math.floor(config.totalSeats * 0.45));
  const adjustment = Math.floor(Math.min(dayOffset / 4, reservedUnits));

  return [
    buildTransportCode(config.codePrefix, sourceCity.city_id, destinationCity.city_id, dayOffset),
    `${config.operatorName} ${sourceCity.city_name}-${destinationCity.city_name}`,
    sourceCity.city_id,
    destinationCity.city_id,
    formatDate(travelDate),
    formatTime(departureHour),
    formatTime(departureHour + durationHours),
    config.classType,
    dynamicPrice,
    config.totalSeats,
    Math.max(1, config.availableSeats - adjustment),
    config.rating
  ];
}

async function ensureTransportCoverage() {
  const [cities] = await pool.query('SELECT city_id, city_name FROM cities ORDER BY city_id');
  if (cities.length < 2) return;

  for (const [transportType, config] of Object.entries(TRANSPORT_CONFIG)) {
    const recordsToInsert = [];

    for (const sourceCity of cities) {
      for (const destinationCity of cities) {
        if (sourceCity.city_id === destinationCity.city_id) continue;

        const [[existingRoute]] = await pool.query(
          `SELECT COUNT(*) AS total
           FROM ${config.table}
           WHERE source_city_id = ? AND destination_city_id = ?
             AND travel_date >= CURDATE()`,
          [sourceCity.city_id, destinationCity.city_id]
        );

        if (existingRoute.total > 0) continue;

        DAY_OFFSETS.forEach((dayOffset) => {
          recordsToInsert.push(buildTransportRecord(transportType, sourceCity, destinationCity, dayOffset));
        });
      }
    }

    if (recordsToInsert.length) {
      await pool.query(
        `INSERT INTO ${config.table}
         (code, operator_name, source_city_id, destination_city_id, travel_date, depart_time, arrive_time, class_type, price, total_seats, available_seats, rating)
         VALUES ?`,
        [recordsToInsert]
      );
    }
  }
}

async function ensureHotelCoverage() {
  const [cities] = await pool.query('SELECT city_id, city_name FROM cities ORDER BY city_id');
  if (!cities.length) return;

  const hotelRecordsToInsert = [];

  for (const city of cities) {
    for (const variant of HOTEL_VARIANTS) {
      const hotelName = `${city.city_name} ${variant.suffix}`;
      const [[existingHotel]] = await pool.query(
        'SELECT COUNT(*) AS total FROM hotels WHERE city_id = ? AND hotel_name = ? AND room_type = ?',
        [city.city_id, hotelName, variant.roomType]
      );

      if (existingHotel.total > 0) continue;

      hotelRecordsToInsert.push([
        hotelName,
        city.city_id,
        variant.roomType,
        variant.amenities,
        variant.pricePerNight + city.city_id * 90,
        variant.totalRooms,
        variant.availableRooms,
        variant.rating
      ]);
    }
  }

  if (hotelRecordsToInsert.length) {
    await pool.query(
      `INSERT INTO hotels
       (hotel_name, city_id, room_type, amenities, price_per_night, total_rooms, available_rooms, rating)
       VALUES ?`,
      [hotelRecordsToInsert]
    );
  }
}

async function ensureDemoInventoryCoverage() {
  await ensureTransportCoverage();
  await ensureHotelCoverage();
}

module.exports = { ensureDemoInventoryCoverage };
