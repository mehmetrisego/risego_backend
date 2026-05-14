'use strict';

const db = require('./index');

/**
 * Sürücünün tüm para çekme geçmişini döner
 * @param {string} driverId - Yandex sürücü ID
 * @param {number} limit - Maksimum kayıt sayısı
 */
async function getDriverPaymentLogs(driverId, limit = 50) {
    if (!db.isConfigured()) return [];
    
    try {
        const result = await db.query(
            `SELECT 
                id, 
                beneficiary_name, 
                beneficiary_iban, 
                amount, 
                gross_amount, 
                status, 
                error_message, 
                bank_status_code,
                created_at,
                updated_at,
                yandex_refund_at
             FROM payment_logs 
             WHERE driver_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2`,
            [driverId, limit]
        );
        return result.rows;
    } catch (err) {
        console.error('[db/paymentLogs] getDriverPaymentLogs hatası:', err.message);
        throw err;
    }
}

module.exports = {
    getDriverPaymentLogs
};
