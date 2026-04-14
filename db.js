const fs = require('fs');
const DB_FILE = './db.json';

function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(data);
        // Ensure all fields exist (backwards-compat with old db.json)
        if (!parsed.tokens)     parsed.tokens     = {};
        if (!parsed.knownUsers) parsed.knownUsers = [];
        return parsed;
    } catch (e) {
        return { channels: [], tokens: {}, knownUsers: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Token helpers ──────────────────────────────────────────────────────────────

/** Return the stored JWT for a Telegram user, or null. */
function getToken(telegramId) {
    const db = readDB();
    return db.tokens[String(telegramId)] || null;
}

/** Persist a JWT for a Telegram user. */
function setToken(telegramId, token) {
    const db = readDB();
    db.tokens[String(telegramId)] = token;
    writeDB(db);
}

// ── Known-lead helpers ─────────────────────────────────────────────────────────

/** Return true if we already created (or confirmed) a lead for this user. */
function isKnownLead(telegramId) {
    const db = readDB();
    return db.knownUsers.includes(String(telegramId));
}

/** Mark a Telegram user as having a lead in the backend. */
function markKnownLead(telegramId) {
    const db = readDB();
    const id = String(telegramId);
    if (!db.knownUsers.includes(id)) {
        db.knownUsers.push(id);
        writeDB(db);
    }
}

module.exports = { readDB, writeDB, getToken, setToken, isKnownLead, markKnownLead };
