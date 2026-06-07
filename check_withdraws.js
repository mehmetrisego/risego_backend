require('dotenv').config();
const db = require('./db');

(async () => {
    try {
        const res = await db.query(`SELECT driver_id, amount, status, error_message, created_at FROM payment_logs WHERE created_at >= '2026-06-06 18:00:00' ORDER BY created_at DESC`);
        console.table(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
})();
