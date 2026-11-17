'use strict';

// Read-only route probe: uses impossible identifiers and never creates a transaction.
const config = require('../config');
const db = require('../db');
const yandexFleetApi = require('../services/yandexFleetApi');

async function target() {
    if (!db.isConfigured()) {
        return {
            driverId: '00000000000000000000000000000000',
            parkPartnerId: config.yandexFleet.partnerId
        };
    }
    const result = await db.query(
        `SELECT driver_id, park_partner_id FROM payment_logs
         WHERE park_partner_id IS NOT NULL AND park_partner_id <> ''
         ORDER BY id DESC LIMIT 1`
    );
    return {
        driverId: result.rows[0]?.driver_id || '00000000000000000000000000000000',
        parkPartnerId: result.rows[0]?.park_partner_id || config.yandexFleet.partnerId
    };
}

async function main() {
    const watchdog = setTimeout(() => {
        console.log('v3_status_http=timeout');
        console.log('v3_status_code=PROBE_TIMEOUT');
        process.exit(2);
    }, 20000);
    try {
        const probeTarget = await target();
        await yandexFleetApi.getTransactionStatusV3({
            driverId: probeTarget.driverId,
            parkPartnerId: probeTarget.parkPartnerId,
            transactionId: '00000000000000000000000000000000',
            version: 1
        });
        console.log('v3_status_http=200');
    } catch (error) {
        console.log(`v3_status_http=${error.response?.status || 'timeout'}`);
        console.log(`v3_status_code=${error.response?.data?.code || error.code || 'unknown'}`);
        console.log(`v3_status_message=${error.response?.data?.message || error.message}`);
    } finally {
        clearTimeout(watchdog);
    }
}

main().then(() => process.exit(0)).catch(error => {
    console.error(`v3_probe_error=${error.message}`);
    process.exit(1);
});
