const db = require('./index');

function normalizeIban(iban) {
    return String(iban || '').replace(/\s+/g, '').toUpperCase();
}

async function getDriverBankAccounts(driverId) {
    if (!db.isConfigured()) return [];

    const result = await db.query(
        `SELECT id, driver_id, iban, account_holder_name,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM driver_bank_accounts
         WHERE driver_id = $1
         ORDER BY created_at DESC`,
        [driverId]
    );

    return result.rows.map(row => ({
        id: row.id,
        driverId: row.driver_id,
        iban: row.iban,
        accountHolderName: row.account_holder_name,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null
    }));
}

async function addDriverBankAccount(driverId, iban, accountHolderName) {
    if (!db.isConfigured()) throw new Error('DB not configured');

    const normalizedIban = normalizeIban(iban);
    const normalizedName = String(accountHolderName || '').trim();

    // Bir sürücü için maksimum 5 hesap sınırlaması (opsiyonel ama iyi bir pratik)
    const existing = await getDriverBankAccounts(driverId);
    if (existing.length >= 5) {
        throw new Error('En fazla 5 banka hesabı kaydedebilirsiniz.');
    }

    const result = await db.query(
        `INSERT INTO driver_bank_accounts (driver_id, iban, account_holder_name, updated_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, driver_id, iban, account_holder_name,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [driverId, normalizedIban, normalizedName]
    );

    const row = result.rows[0];
    return {
        id: row.id,
        driverId: row.driver_id,
        iban: row.iban,
        accountHolderName: row.account_holder_name,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null
    };
}

async function deleteDriverBankAccount(driverId, accountId) {
    if (!db.isConfigured()) throw new Error('DB not configured');

    const result = await db.query(
        'DELETE FROM driver_bank_accounts WHERE id = $1 AND driver_id = $2 RETURNING id',
        [accountId, driverId]
    );

    return result.rowCount > 0;
}

module.exports = {
    getDriverBankAccounts,
    addDriverBankAccount,
    deleteDriverBankAccount,
    normalizeIban
};
