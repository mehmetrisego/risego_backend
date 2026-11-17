'use strict';

const util = require('util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const minimumLevel = LEVELS[configuredLevel] || LEVELS.info;
const dedupeWindowMs = Math.max(1000, Number(process.env.LOG_DEDUPE_WINDOW_MS) || 60000);
const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};
const repeated = new Map();

const SECRET_KEY = /(authorization|password|secret|token|api[_-]?key|cookie|session|credential)/i;
const SENSITIVE_INLINE = [
    [/(\bTR)\d{20}(\d{4}\b)/gi, '$1********************$2'],
    [/(\b(?:\+?90|0)?5\d{2})\d{3}(\d{4}\b)/g, '$1***$2'],
    [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
    [/(password|token|secret|api[_-]?key)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]'],
    [/(otp|doğrulama kodu|beklenen|girilen)(\s*[=:]\s*)[A-Za-z0-9_-]+/gi, '$1$2[REDACTED]'],
];

function redactText(value) {
    let text = String(value ?? '');
    for (const [pattern, replacement] of SENSITIVE_INLINE) text = text.replace(pattern, replacement);
    return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeValue(key, value) {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    if (value == null) return value;
    if (value instanceof Error) return redactText(value.message);
    if (typeof value === 'string') return redactText(value);
    if (typeof value === 'object') {
        if (Array.isArray(value)) return value.map((item) => safeValue(key, item));
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, safeValue(childKey, childValue)]));
    }
    return value;
}

function displayValue(value) {
    if (value == null) return '-';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const clean = redactText(text);
    return /\s/.test(clean) ? JSON.stringify(clean) : clean;
}

function normalizeCategory(category) {
    return String(category || 'APP').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase().slice(0, 18) || 'APP';
}

function timestamp() {
    return new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date()).replace(',', '');
}

function inferredContext(category) {
    const value = String(category || '').toLowerCase();
    if (value.includes('yandex')) return { service: 'yandex-fleet-api', provider: 'Yandex-Fleet' };
    if (value.includes('upt')) return { service: 'upt-service', provider: 'UPT' };
    if (value.includes('payment') || value.includes('withdraw')) return { service: 'payment-service', provider: 'internal' };
    if (value === 'db' || value.includes('database')) return { service: 'database-service', provider: 'Railway-PostgreSQL' };
    if (value.includes('auth')) return { service: 'auth-service', provider: 'internal' };
    if (value.includes('leaderboard')) return { service: 'leaderboard-service', provider: 'Yandex-Fleet' };
    if (value.includes('sync')) return { service: 'sync-service', provider: 'Yandex-Fleet' };
    if (value.includes('cron')) return { service: 'cron-manager', provider: 'internal' };
    if (value.includes('netgsm')) return { service: 'sms-service', provider: 'NetGSM' };
    if (value.includes('server')) return { service: 'api-server', provider: 'internal' };
    return { service: value ? `${value.replace(/[^a-z0-9]+/g, '-')}-service` : 'application', provider: 'internal' };
}

function write(level, category, message, fields = {}, error = null, options = {}) {
    if ((LEVELS[level] || LEVELS.info) < minimumLevel) return;

    const safeFields = safeValue('', { ...inferredContext(category), ...(fields || {}) });
    const fieldText = Object.entries(safeFields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${displayValue(value)}`)
        .join(' ');
    const line = `${timestamp()} ${level.toUpperCase().padEnd(5)} [${normalizeCategory(category)}] ${redactText(message)}${fieldText ? `  ${fieldText}` : ''}`;
    const key = `${level}|${category}|${redactText(message)}|${fieldText}`;

    if (options.dedupe !== false && (level === 'warn' || level === 'error')) {
        const previous = repeated.get(key);
        const now = Date.now();
        if (previous && now - previous.firstAt < dedupeWindowMs) {
            previous.count += 1;
            previous.lastAt = now;
            return;
        }
        if (previous?.count > 1) {
            originalConsole.warn(`${timestamp()} WARN  [LOGGER] Tekrarlanan loglar bastırıldı  repeated=${previous.count - 1} category=${normalizeCategory(category)}`);
        }
        repeated.set(key, { firstAt: now, lastAt: now, count: 1 });
    }

    const sink = level === 'error' ? originalConsole.error : level === 'warn' ? originalConsole.warn : originalConsole.log;
    sink(line);
    if (level === 'error' && error?.stack && process.env.LOG_STACK === 'true') {
        sink(redactText(error.stack));
    }
}

function createLogger(category, defaults = {}) {
    const emit = (level, message, fields, error, options) =>
        write(level, category, message, { ...defaults, ...(fields || {}) }, error, options);
    return {
        debug: (message, fields) => emit('debug', message, fields),
        info: (message, fields) => emit('info', message, fields),
        warn: (message, fields, options) => emit('warn', message, fields, null, options),
        error: (message, fields, error, options) => emit('error', message, fields, error, options),
    };
}

function legacyArgs(args) {
    const first = args[0];
    let category = 'APP';
    let messageArgs = args;
    if (typeof first === 'string') {
        const match = first.match(/^\[([^\]]+)\]\s*(.*)$/s);
        if (match) {
            category = match[1];
            messageArgs = [match[2], ...args.slice(1)];
        }
    }
    const message = messageArgs.map((item) => {
        if (item instanceof Error) return item.message;
        return typeof item === 'string' ? item : util.inspect(safeValue('', item), { depth: 3, breakLength: Infinity, compact: true });
    }).join(' ');
    return { category, message };
}

function installConsoleBridge() {
    if (console.__risegoStructuredLogger) return;
    Object.defineProperty(console, '__risegoStructuredLogger', { value: true });
    console.log = (...args) => { const value = legacyArgs(args); write('info', value.category, value.message); };
    console.info = console.log;
    console.warn = (...args) => { const value = legacyArgs(args); write('warn', value.category, value.message); };
    console.error = (...args) => {
        const value = legacyArgs(args);
        const error = args.find((item) => item instanceof Error);
        write('error', value.category, value.message, {}, error);
    };
}

function maskId(value, visible = 4) {
    const text = String(value || 'unknown');
    return text.length <= visible ? `***${text}` : `***${text.slice(-visible)}`;
}

module.exports = { createLogger, installConsoleBridge, maskId, redactText };
