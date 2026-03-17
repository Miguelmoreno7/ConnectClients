// MySQL pool + helpers for WordPress-prefixed table access.
const mysql = require("mysql2/promise");

// Shared connection pool for all DB operations in the service.
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Builds a table name using configurable WP prefix (e.g. wp_ + wa_configurations).
const getTableName = (suffix) => {
  const prefix = process.env.WP_TABLE_PREFIX || "wp_";
  return `${prefix}${suffix}`;
};

// Runs a callback with a pooled connection and always releases the connection.
const withConnection = async (fn) => {
  const connection = await pool.getConnection();
  try {
    return await fn(connection);
  } finally {
    connection.release();
  }
};

module.exports = {
  pool,
  getTableName,
  withConnection
};
