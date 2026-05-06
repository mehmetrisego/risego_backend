const db = require('./index');

function normalizeIban(iban) {
    return String(iban || '').replace(/\s+/g, '').toUpperCase();
}

async function getDriverBankAccount(driverId) {
    if (!db.isConfigured()) return null;

    const result = await db.query(
        `SELECT driver_id, iban, account_holder_name,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM driver_bank_accounts
         WHERE driver_id = $1
         LIMIT 1`,
        [driverId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
        driverId: row.driver_id,
        iban: row.iban,
        accountHolderName: row.account_holder_name,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null
    };
}

async function upsertDriverBankAccount(driverId, iban, accountHolderName) {
    if (!db.isConfigured()) throw new Error('DB not configured');

    const normalizedIban = normalizeIban(iban);
    const normalizedName = String(accountHolderName || '').trim();

    const result = await db.query(
        `INSERT INTO driver_bank_accounts (driver_id, iban, account_holder_name, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET
            iban = EXCLUDED.iban,
            account_holder_name = EXCLUDED.account_holder_name,
            updated_at = NOW()
         RETURNING driver_id, iban, account_holder_name,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [driverId, normalizedIban, normalizedName]
    );

    const row = result.rows[0];
    return {
        driverId: row.driver_id,
        iban: row.iban,
        accountHolderName: row.account_holder_name,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null
    };
}

module.exports = {
    getDriverBankAccount,
    upsertDriverBankAccount,
    normalizeIban
};
