/* const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'parfum',
  port: 8889, // Port MAMP par défaut
  waitForConnections: true,
  connectionLimit: 10
});

module.exports = pool;
 */



const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || 'root',
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'parfum',
    port: process.env.MYSQLPORT || process.env.MYSQL_PORT || 8889,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;