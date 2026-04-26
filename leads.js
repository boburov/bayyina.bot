/**
 * leads.js — Backend API integration for leads.
 *
 * Since POST /leads requires auth (admin/teacher), the bot uses
 * a service token stored in BOT_SERVICE_TOKEN env var.
 * Alternatively, if no service token is set, it falls back to any
 * admin token saved from the login flow.
 */

require('dotenv').config();
const axios = require('axios');
const { getToken, getAnyAdminToken } = require('./db');

const BACKEND_URL = process.env.BACKEND_URL || 'http://api.bayyina.org.uz/api';
const PAGE_SIZE = 8;

// ─── Axios factory ────────────────────────────────────────────────────────────

function api(token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return axios.create({ baseURL: BACKEND_URL, timeout: 10_000, headers });
}

/** Resolve the service token to use for bot-initiated actions. */
function serviceToken(telegramId) {
    return (
        process.env.BOT_SERVICE_TOKEN ||
        getAnyAdminToken() ||
        getToken(String(telegramId)) ||
        null
    );
}

// ─── Create lead ──────────────────────────────────────────────────────────────

/**
 * POST /leads
 * Tries with auth token first; if no token, tries without auth
 * (public lead-submission endpoints don't require auth).
 */
async function createLead(data, botTelegramId) {
    const token = serviceToken(botTelegramId);

    const payload = {
        firstName: data.firstName,
        phone: data.phone ? Number(String(data.phone).replace(/\D/g, '')) : undefined,
        telegramId: String(data.telegramId),
        gender: data.gender,
        age: data.age ? Number(data.age) : undefined,
        profession: data.profession,
        source: data.source || 'telegram',
        interest: data.interest,
        uniqueLink: data.uniqueLink,
    };

    try {
        const res = await api(token).post('/leads', payload);
        return { success: true, lead: res.data.lead || res.data };
    } catch (err) {
        // If auth failed and we had a token, retry without token
        if (err.response?.status === 401 && token) {
            try {
                const res = await api(null).post('/leads', payload);
                return { success: true, lead: res.data.lead || res.data };
            } catch (err2) {
                if (err2.response?.status === 409) return { success: false, error: 'duplicate' };
                return { success: false, error: err2.response?.data?.message || err2.message };
            }
        }
        if (err.response?.status === 409) return { success: false, error: 'duplicate' };
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ─── Update lead status ───────────────────────────────────────────────────────

async function updateLeadStatus(leadId, status, telegramId) {
    const token = getToken(String(telegramId));
    if (!token) return { success: false, error: 'no_token' };
    try {
        const res = await api(token).put(`/leads/${leadId}`, { status });
        return { success: true, lead: res.data.lead };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ─── Get leads list ───────────────────────────────────────────────────────────

async function getLeadsList(telegramId, page = 1, filters = {}) {
    const token = getToken(String(telegramId));
    if (!token) return { success: false, error: 'no_token' };
    try {
        const params = { page, limit: PAGE_SIZE, ...filters };
        const res = await api(token).get('/leads', { params });
        const data = res.data;
        return {
            success: true,
            leads: data.leads || [],
            total: data.total || 0,
            pages: data.pages || 1,
        };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ─── Get single lead ──────────────────────────────────────────────────────────

async function getLead(leadId, telegramId) {
    const token = getToken(String(telegramId));
    if (!token) return { success: false, error: 'no_token' };
    try {
        const res = await api(token).get(`/leads/${leadId}`);
        return { success: true, lead: res.data.lead || res.data };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ─── Get groups ───────────────────────────────────────────────────────────────

async function getGroups(telegramId) {
    const token = getToken(String(telegramId));
    if (!token) return [];
    try {
        const res = await api(token).get('/groups');
        return res.data.groups || res.data || [];
    } catch {
        return [];
    }
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtStatus(status) {
    return {
        new: '🆕 Yangi',
        contacted: '📞 Bog\'lashildi',
        interested: '💡 Qiziqyapti',
        scheduled: '📅 Rejalashtirildi',
        rejected: '❌ Rad etildi',
        converted: '🎓 Qabul qilindi',
    }[status] || status;
}

function fmtLead(lead) {
    const lines = [
        `👤 <b>${lead.firstName || 'Noma\'lum'}</b>`,
        '',
        `📊 Holat: <b>${fmtStatus(lead.status)}</b>`,
        `📞 Telefon: ${lead.phone || '—'}`,
        `✈️ Telegram: <code>${lead.telegramId || '—'}</code>`,
        `⚧  Jins: ${lead.gender === 'male' ? '👨 Erkak' : lead.gender === 'female' ? '👩 Ayol' : '—'}`,
        `🎂 Yosh: ${lead.age || '—'}`,
        `💼 Kasb: ${lead.profession || '—'}`,
        `📢 Manba: ${lead.source || '—'}`,
        `📚 Qiziqish: ${lead.interest || '—'}`,
        `📅 ${lead.createdAt ? new Date(lead.createdAt).toLocaleDateString('uz-UZ') : '—'}`,
    ];
    if (lead.notes) lines.push(`📝 ${lead.notes}`);
    return lines.join('\n');
}

module.exports = {
    createLead,
    updateLeadStatus,
    getLeadsList,
    getLead,
    getGroups,
    fmtStatus,
    fmtLead,
    PAGE_SIZE,
};
