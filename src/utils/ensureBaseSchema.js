const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function ensureBaseSchema() {
  const schemaPath = path.join(__dirname, '../../sql/schema.sql');
  const rawSchema = await fs.readFile(schemaPath, 'utf8');
  const sanitizedSchema = rawSchema
    .replace(/^\s*CREATE DATABASE\s+IF NOT EXISTS\s+.+?;\s*$/gim, '')
    .replace(/^\s*USE\s+.+?;\s*$/gim, '');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true
  });

  try {
    for (const statement of splitStatements(sanitizedSchema)) {
      await connection.query(statement);
    }
  } finally {
    await connection.end();
  }
}

module.exports = { ensureBaseSchema };
