require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function run() {
  const query = `
    SELECT status, count(*) as c 
    FROM payment_logs 
    WHERE updated_at >= '2026-06-10 00:00:00' AND updated_at < '2026-06-11 00:00:00' 
    GROUP BY status
  `;
  const res = await pool.query(query);
  console.log(JSON.stringify(res.rows));
  process.exit(0);
}
run();
