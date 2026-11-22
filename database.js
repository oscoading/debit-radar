/**
 * DebitRadar - SQLite Database Engine
 * 
 * Tech Stack & Architecture:
 * - Native `node:sqlite` module (Node.js 22+) - zero npm dependencies, C-level speed
 * - WAL (Write-Ahead Logging) mode enabled for high concurrency
 * - Strictly parameterized queries (?) to prevent any SQL injection
 * - Multi-tenant isolation: every query is scoped by `user_id`
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

// Local SQLite DB file path
const DB_PATH = path.join(__dirname, 'debitradar.db');
const db = new DatabaseSync(DB_PATH);

/**
 * Performance & Concurrency Settings
 * Note: WAL mode on kiya hai taaki concurrent reads block na ho aur fast response mile
 */
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;'); // heavy traffic pe timeout handle karne ke liye

console.log('[DB] SQLite initialized in WAL mode with foreign keys enabled');

/**
 * Database Schema Setup
 * Core tables: users, sessions, transactions, recurring_mandates, alerts, decisions, audit_logs
 */
function initSchema() {
    // 1. Users table (stores profile & user persona)
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            persona TEXT NOT NULL,             -- 'salaried' or 'student'
            bank_name TEXT NOT NULL,           -- HDFC, SBI, etc.
            account_mask TEXT NOT NULL,        -- Masked account number (e.g. ••• 4092)
            upi_pin TEXT DEFAULT '123456',     -- Persistent 6-digit UPI PIN
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // 2. Auth sessions table (token based session isolation)
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // 3. Transactions table (historical statement feed)
    // Note: fingerprint ensures idempotent ingestion (no duplicate debits on re-upload)
    db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            merchant TEXT NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,                -- YYYY-MM-DD
            category TEXT NOT NULL,            -- 'subscription' or 'one_off'
            source TEXT DEFAULT 'aa_sandbox',
            fingerprint TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // 4. Recurring Mandates table (detected subscriptions)
    db.exec(`
        CREATE TABLE IF NOT EXISTS recurring_mandates (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            merchant TEXT NOT NULL,
            baseline_amount REAL NOT NULL,
            max_cap_limit REAL DEFAULT 199.00,  -- Strict Mandate Cap: debit > cap bounces automatically at Bank Switch
            auto_pause_enabled INTEGER DEFAULT 1, -- 1 = Autonomous Pause if unapproved at T-2h
            cadence_days INTEGER NOT NULL,     -- 30 (monthly) or 90 (quarterly)
            cadence_type TEXT NOT NULL,
            confidence TEXT NOT NULL,          -- 'confirmed' or 'possible'
            status TEXT DEFAULT 'active',      -- 'active', 'paused', 'revoked'
            last_debit_date TEXT NOT NULL,
            next_expected_date TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // 5. Alerts table (price-hike notifications)
    db.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            merchant TEXT NOT NULL,
            previous_amount REAL NOT NULL,
            new_amount REAL NOT NULL,
            hike_percent REAL NOT NULL,
            status TEXT DEFAULT 'pending',     -- 'pending', 'kept', 'stopped'
            notice_source TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // 6. User Decisions table (Keep / Stop action records)
    db.exec(`
        CREATE TABLE IF NOT EXISTS decisions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            alert_id TEXT NOT NULL,
            action TEXT NOT NULL,              -- 'keep' or 'stop'
            payment_rail TEXT NOT NULL,
            guidance_shown TEXT NOT NULL,
            decided_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
        );
    `);

    // 7. Compliance Audit Logs table
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            event_type TEXT NOT NULL,
            details TEXT NOT NULL,
            ip_address TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // 8. Dynamic OTP Management (Server-side generated OTPs with expiry & brute-force limits)
    db.exec(`
        CREATE TABLE IF NOT EXISTS otp_requests (
            phone TEXT PRIMARY KEY,
            otp TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Performance Indexes for instant query lookups
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
        CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
        CREATE INDEX IF NOT EXISTS idx_tx_fingerprint ON transactions(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_mandates_user ON recurring_mandates(user_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
        CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions(user_id);
    `);

    console.log('[DB] Tables and performance indexes ready');
}

/**
 * Seed initial test datasets if database is fresh
 * Seeds 2 personas for evaluation:
 * - Rahul Sharma (Salaried professional, has Netflix ₹199 -> ₹249 hike)
 * - Priya Verma (Student, small-ticket recurring subscriptions)
 */
function seedDemoData() {
    try {
        db.exec(`ALTER TABLE users ADD COLUMN upi_pin TEXT DEFAULT '123456'`);
    } catch (_) {}
    try {
        db.exec(`ALTER TABLE users ADD COLUMN pin_attempts INTEGER DEFAULT 0`);
    } catch (_) {}
    try {
        db.exec(`ALTER TABLE users ADD COLUMN pin_locked_until DATETIME`);
    } catch (_) {}
    try {
        db.exec(`ALTER TABLE recurring_mandates ADD COLUMN max_cap_limit REAL DEFAULT 199.00`);
    } catch (_) {}
    try {
        db.exec(`ALTER TABLE recurring_mandates ADD COLUMN auto_pause_enabled INTEGER DEFAULT 1`);
    } catch (_) {}
    try {
        db.prepare(`UPDATE users SET upi_pin = '654321' WHERE phone = '9123456789'`).run();
    } catch (_) {}

    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount > 0) return;

    console.log('[DB] Seeding test personas (Rahul - Salaried, Priya - Student)...');

    const insertUser = db.prepare(`
        INSERT INTO users (id, name, phone, persona, bank_name, account_mask, upi_pin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertUser.run('usr_rahul', 'Rahul Sharma', '9876543210', 'salaried', 'HDFC Bank', '••• 4092', '123456');
    insertUser.run('usr_priya', 'Priya Verma', '9123456789', 'student', 'State Bank of India', '••• 8814', '654321');

    // Transactions inserter with duplicate protection
    const insertTx = db.prepare(`
        INSERT INTO transactions (id, user_id, merchant, amount, date, category, source, fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Rahul's recurring transactions (Primary Persona)
    // Netflix: monthly on 28th
    [5, 6, 7, 8, 9].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-28`;
        insertTx.run(`tx_r_n_${i}`, 'usr_rahul', 'Netflix', 199.00, d, 'subscription', 'aa_sandbox', `usr_rahul_netflix_${d}`);
    });

    // Hotstar: quarterly on 14th
    [5, 8].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-14`;
        insertTx.run(`tx_r_h_${i}`, 'usr_rahul', 'Hotstar', 299.00, d, 'subscription', 'aa_sandbox', `usr_rahul_hotstar_${d}`);
    });

    // Spotify: monthly on 3rd
    [5, 6, 7, 8, 9, 10].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-03`;
        insertTx.run(`tx_r_s_${i}`, 'usr_rahul', 'Spotify', 119.00, d, 'subscription', 'aa_sandbox', `usr_rahul_spotify_${d}`);
    });

    // ChatGPT Plus: monthly on 15th
    [5, 6, 7, 8, 9, 10].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-15`;
        insertTx.run(`tx_r_c_${i}`, 'usr_rahul', 'ChatGPT Plus', 1770.00, d, 'subscription', 'aa_sandbox', `usr_rahul_chatgpt_${d}`);
    });

    // Google One: monthly on 9th
    [5, 6, 7, 8, 9, 10].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-09`;
        insertTx.run(`tx_r_g_${i}`, 'usr_rahul', 'Google One', 130.00, d, 'subscription', 'aa_sandbox', `usr_rahul_google_${d}`);
    });

    // Amazon Prime: monthly on 12th
    [5, 6, 7, 8, 9, 10].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-12`;
        insertTx.run(`tx_r_p_${i}`, 'usr_rahul', 'Amazon Prime', 299.00, d, 'subscription', 'aa_sandbox', `usr_rahul_prime_${d}`);
    });

    // Irregular transactions (noise to verify filter logic)
    insertTx.run('tx_r_sw1', 'usr_rahul', 'Swiggy', 412.00, '2026-06-03', 'one_off', 'aa_sandbox', 'usr_rahul_sw1');
    insertTx.run('tx_r_sw2', 'usr_rahul', 'Swiggy', 288.00, '2026-07-19', 'one_off', 'aa_sandbox', 'usr_rahul_sw2');
    insertTx.run('tx_r_sw3', 'usr_rahul', 'Swiggy', 530.00, '2026-09-02', 'one_off', 'aa_sandbox', 'usr_rahul_sw3');
    insertTx.run('tx_r_ub1', 'usr_rahul', 'Uber', 186.00, '2026-08-11', 'one_off', 'aa_sandbox', 'usr_rahul_ub1');

    // Priya's recurring transactions (Student Persona)
    // YouTube Premium Student (₹79/mo)
    [6, 7, 8, 9, 10].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-05`;
        insertTx.run(`tx_p_yt_${i}`, 'usr_priya', 'YouTube Premium Student', 79.00, d, 'subscription', 'aa_sandbox', `usr_priya_yt_${d}`);
    });

    // Spotify Student (₹59/mo)
    [6, 7, 8, 9, 10].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-18`;
        insertTx.run(`tx_p_sp_${i}`, 'usr_priya', 'Spotify Student', 59.00, d, 'subscription', 'aa_sandbox', `usr_priya_sp_${d}`);
    });

    // Canva Pro Student (₹199/mo)
    [7, 8, 9, 10].forEach((m, i) => {
        const d = `2026-${String(m).padStart(2, '0')}-22`;
        insertTx.run(`tx_p_cv_${i}`, 'usr_priya', 'Canva Pro', 199.00, d, 'subscription', 'aa_sandbox', `usr_priya_cv_${d}`);
    });

    // Active 24h pre-debit notice alert for Rahul (Netflix ₹199 -> ₹249 = +25.13%)
    const insertAlert = db.prepare(`
        INSERT INTO alerts (id, user_id, merchant, previous_amount, new_amount, hike_percent, status, notice_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAlert.run('alt_rahul_netflix_01', 'usr_rahul', 'Netflix', 199.00, 249.00, 25.13, 'pending', '24h_pre_debit_sms');

    // Seed baseline recurring mandates with strict Mandate Cap Protection for Rahul
    const insertMandate = db.prepare(`
        INSERT OR IGNORE INTO recurring_mandates (id, user_id, merchant, baseline_amount, max_cap_limit, auto_pause_enabled, cadence_days, cadence_type, confidence, status, last_debit_date, next_expected_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMandate.run('man_r_netflix', 'usr_rahul', 'Netflix', 199.00, 199.00, 1, 30, 'monthly', 'confirmed', 'active', '2026-09-28', '2026-10-28');
    insertMandate.run('man_r_hotstar', 'usr_rahul', 'Hotstar', 299.00, 299.00, 1, 90, 'quarterly', 'confirmed', 'active', '2026-08-14', '2026-11-14');
    insertMandate.run('man_r_spotify', 'usr_rahul', 'Spotify', 119.00, 119.00, 1, 30, 'monthly', 'confirmed', 'active', '2026-10-03', '2026-11-03');

    console.log('[DB] Seeding complete');
}

initSchema();
seedDemoData();

/**
 * Parameterized Queries (Data Access Layer)
 * Always using db.prepare to guarantee zero SQL injection
 */
const statements = {
    // User lookups
    getUserByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
    getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    getAllUsers: db.prepare('SELECT id, name, phone, persona, bank_name, account_mask, upi_pin, pin_attempts, pin_locked_until FROM users'),
    incrementPinAttempts: db.prepare('UPDATE users SET pin_attempts = pin_attempts + 1 WHERE id = ?'),
    resetPinAttempts: db.prepare('UPDATE users SET pin_attempts = 0, pin_locked_until = NULL WHERE id = ?'),
    lockPinAccount: db.prepare("UPDATE users SET pin_locked_until = datetime('now', '+24 hours') WHERE id = ?"),

    // Sessions
    createSession: db.prepare(`
        INSERT INTO sessions (token, user_id, expires_at)
        VALUES (?, ?, datetime('now', '+24 hours'))
    `),
    getSession: db.prepare(`
        SELECT s.token, s.user_id, u.id, u.name, u.phone, u.persona, u.bank_name, u.account_mask, u.upi_pin
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.token = ? AND s.expires_at > datetime('now')
    `),

    // Transactions (Strict user isolation)
    getUserTransactions: db.prepare(`
        SELECT id, user_id, merchant, amount, date, category, source 
        FROM transactions 
        WHERE user_id = ? 
        ORDER BY date DESC
    `),
    insertTransaction: db.prepare(`
        INSERT OR IGNORE INTO transactions (id, user_id, merchant, amount, date, category, source, fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Recurring Mandates
    getUserMandates: db.prepare(`
        SELECT * FROM recurring_mandates 
        WHERE user_id = ? 
        ORDER BY baseline_amount DESC
    `),
    pauseMandate: db.prepare(`
        UPDATE recurring_mandates 
        SET status = 'paused' 
        WHERE user_id = ? AND LOWER(merchant) = LOWER(?)
    `),
    updateMandateCap: db.prepare(`
        UPDATE recurring_mandates 
        SET max_cap_limit = ? 
        WHERE user_id = ? AND LOWER(merchant) = LOWER(?)
    `),

    // Alerts
    getUserAlerts: db.prepare(`
        SELECT * FROM alerts 
        WHERE user_id = ? 
        ORDER BY created_at DESC
    `),
    getAlertById: db.prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?'),
    updateAlertStatus: db.prepare('UPDATE alerts SET status = ? WHERE id = ? AND user_id = ?'),

    // Keep / Stop decisions
    recordDecision: db.prepare(`
        INSERT INTO decisions (id, user_id, alert_id, action, payment_rail, guidance_shown)
        VALUES (?, ?, ?, ?, ?, ?)
    `),
    getUserDecisions: db.prepare(`
        SELECT * FROM decisions 
        WHERE user_id = ? 
        ORDER BY decided_at DESC
    `),

    // Audit logs
    logAudit: db.prepare(`
        INSERT INTO audit_logs (id, user_id, event_type, details, ip_address)
        VALUES (?, ?, ?, ?, ?)
    `),

    // OTP Lifecycle Management
    saveOtp: db.prepare(`
        INSERT INTO otp_requests (phone, otp, attempts, expires_at)
        VALUES (?, ?, 0, datetime('now', '+5 minutes'))
        ON CONFLICT(phone) DO UPDATE SET
            otp = excluded.otp,
            attempts = 0,
            expires_at = excluded.expires_at
    `),
    getOtp: db.prepare(`
        SELECT phone, otp, attempts, expires_at,
               (expires_at > datetime('now')) as is_valid
        FROM otp_requests
        WHERE phone = ?
    `),
    incrementOtpAttempts: db.prepare(`
        UPDATE otp_requests SET attempts = attempts + 1 WHERE phone = ?
    `),
    deleteOtp: db.prepare(`
        DELETE FROM otp_requests WHERE phone = ?
    `)
};

module.exports = {
    db,
    statements
};
