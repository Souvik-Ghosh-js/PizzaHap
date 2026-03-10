const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000,
};

let pool = null;

const getPool = () => {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL Connected Successfully');
  }
  return pool;
};

const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('🔌 MySQL Connection Closed');
  }
};

// Usage: query('SELECT * FROM users WHERE id = ?', [userId])
const query = async (queryStr, params = []) => {
  const poolConn = getPool();
  const [rows] = await poolConn.execute(queryStr, params);
  return rows;
};

const transaction = async (callback) => {
  const poolConn = getPool();
  const connection = await poolConn.getConnection();
  await connection.beginTransaction();
  try {
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
};

module.exports = { getPool, closePool, query, transaction };
