const fs = require('fs');
const DB_FILE = './db.json';
const SESSIONS_FILE = './data/sessions.json';

function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(data);
        if (!parsed.tokens) parsed.tokens = {};
        if (!parsed.knownUsers) parsed.knownUsers = [];
        return parsed;
    } catch (e) {
        return { channels: [], tokens: {}, knownUsers: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Sessions (token + role) ──────────────────────────────────────────────────

function getSessions() {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return {};
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
}

function saveSessions(sessions) {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data');
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function getSession(telegramId) {
    const s = getSessions();
    return s[String(telegramId)] || null;
}

function saveSession(telegramId, data) {
    const s = getSessions();
    s[String(telegramId)] = {
        token: data.token,
        role: data.role || 'student',
        updatedAt: new Date().toISOString()
    };
    saveSessions(s);
}

function removeSession(telegramId) {
    const s = getSessions();
    delete s[String(telegramId)];
    saveSessions(s);
}

// ── Token helpers (Legacy Support) ───────────────────────────────────────────

function getToken(telegramId) {
    const session = getSession(telegramId);
    if (session) return session.token;

    const db = readDB();
    return db.tokens[String(telegramId)] || null;
}

function setToken(telegramId, token, role = 'student') {
    saveSession(telegramId, { token, role });
}

function getAnyAdminToken() {
    const sessions = getSessions();
    for (const s of Object.values(sessions)) {
        if (s.role === 'admin' || s.role === 'teacher') return s.token;
    }
    const db = readDB();
    const tokens = Object.values(db.tokens || {});
    return tokens.length > 0 ? tokens[0] : null;
}

// ── Known-lead helpers ─────────────────────────────────────────────────────────

function isKnownLead(telegramId) {
    const db = readDB();
    return db.knownUsers.includes(String(telegramId));
}

function markKnownLead(telegramId) {
    const db = readDB();
    const id = String(telegramId);
    if (!db.knownUsers.includes(id)) {
        db.knownUsers.push(id);
        writeDB(db);
    }
}

module.exports = {
    readDB, writeDB,
    getToken, setToken,
    getSession, saveSession, removeSession,
    getAnyAdminToken, isKnownLead, markKnownLead
};
