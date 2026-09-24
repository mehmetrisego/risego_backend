// UPT may return Turkish display amounts or SOAP decimal amounts.
function parseUptBalance(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    let value = raw.trim().replace(/\s/g, '').replace(/^(?:TRY|TL|₺)|(?:TRY|TL|₺)$/gi, '');
    if (!/^-?\d[\d.,]*$/.test(value)) return null;
    if (value.includes('.') && value.includes(',')) {
        const decimal = value.lastIndexOf('.') > value.lastIndexOf(',') ? '.' : ',';
        const group = decimal === '.' ? ',' : '.';
        const parts = value.split(decimal);
        if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1])) return null;
        const grouped = new RegExp(`^-?\\d{1,3}(?:\\${group}\\d{3})+$`);
        if (!grouped.test(parts[0])) return null;
        value = parts[0].split(group).join('') + '.' + parts[1];
    } else if (value.includes('.') || value.includes(',')) {
        const separator = value.includes('.') ? '.' : ',';
        const parts = value.split(separator);
        if (parts.length === 2 && /^\d{1,2}$/.test(parts[1])) value = parts.join('.');
        else if (new RegExp(`^-?\\d{1,3}(?:\\${separator}\\d{3})+$`).test(value)) value = parts.join('');
        else return null;
    }
    const balance = Number(value);
    return Number.isFinite(balance) ? balance : null;
}
module.exports = { parseUptBalance };
