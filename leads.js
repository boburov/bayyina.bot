/**
 * leads.js — Full CRM leads integration for the Telegram bot.
 *
 * Exports:
 *   registerLeadsHandlers(bot)  — registers /leads command + all leads callbacks
 *   handleLeadsCallback(bot, query) — routes callback_data for leads
 *   autoCreateLead(msg)         — silently creates a lead on first user interaction
 */

require('dotenv').config();
const axios = require('axios');
const { getToken, setToken, isKnownLead, markKnownLead } = require('./db');

const BACKEND_URL = process.env.BACKEND_URL || 'http://156.67.29.62:4000/api';
const PAGE_SIZE   = 5;

// ── Callback-data prefixes (all ≤ 64 bytes when combined with a 24-char Mongo ID) ──
// leads_p_{n}              pagination
// ld_{id}                  lead details
// lc_{id}                  mark contacted
// ls_{id}                  mark scheduled
// lr_{id}                  mark rejected
// lv_{id}                  start convert flow (select group)
// lg_{leadId}_{groupId}    confirm enrollment  (3+24+1+24 = 52 chars ✓)

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Axios instance pre-configured with a Bearer token. */
function api(token) {
    return axios.create({
        baseURL: BACKEND_URL,
        headers: {
            'Content-Type':  'application/json',
            Authorization:   `Bearer ${token}`,
        },
        timeout: 10_000,
    });
}

/** Human-readable status labels (Uzbek). */
function fmtStatus(status) {
    return {
        new:       '🆕 Yangi',
        contacted: '📞 Bog\'lashildi',
        scheduled: '📅 Rejalashtirildi',
        rejected:  '❌ Rad etildi',
        converted: '🎓 Qabul qilindi',
    }[status] || status;
}

/** Format a single lead as an HTML message. */
function fmtLead(lead) {
    const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Noma\'lum';
    const date = lead.createdAt
        ? new Date(lead.createdAt).toLocaleDateString('uz-UZ')
        : '—';

    return [
        `👤 <b>${name}</b>`,
        ``,
        `📊 Holat: ${fmtStatus(lead.status)}`,
        `📱 Telegram ID: <code>${lead.telegramId || '—'}</code>`,
        `📞 Telefon: ${lead.phone || '—'}`,
        `🔗 Havola: <code>${lead.uniqueLink || '—'}</code>`,
        `💬 Izoh: ${lead.note || '—'}`,
        `📅 Yaratilgan: ${date}`,
    ].join('\n');
}

/** Inline action buttons shown on a lead detail card. */
function actionButtons(leadId) {
    return [
        [
            { text: '📞 Bog\'lashildi', callback_data: `lc_${leadId}` },
            { text: '📅 Rejalashtir',  callback_data: `ls_${leadId}` },
        ],
        [
            { text: '❌ Rad etish',    callback_data: `lr_${leadId}` },
            { text: '🎓 Qabul qilish', callback_data: `lv_${leadId}` },
        ],
        [{ text: '◀️ Ro\'yxatga qaytish', callback_data: 'leads_p_1' }],
    ];
}

/** User-friendly error messages for common HTTP status codes. */
function handleApiError(bot, chatId, err) {
    const msgs = {
        401: '❌ Token muddati tugagan. Qaytadan login qiling.',
        403: '❌ Ruxsat yo\'q.',
        404: '❌ Topilmadi.',
        429: '⏳ Juda ko\'p so\'rov. Biroz kuting.',
    };
    const status = err.response?.status;
    const text   = msgs[status] || `❌ Server xatosi: ${err.response?.data?.message || err.message}`;
    bot.sendMessage(chatId, text).catch(() => {});
}

// ── Auto-create lead on first interaction ──────────────────────────────────────

/**
 * Call on every inbound message/command.
 * If this Telegram user has never been seen before, silently POST /leads.
 */
async function autoCreateLead(msg) {
    const telegramId = String(msg.from.id);
    if (isKnownLead(telegramId)) return;

    try {
        await axios.post(`${BACKEND_URL}/leads`, {
            firstName:  msg.from.first_name || 'Telegram User',
            lastName:   msg.from.last_name  || '',
            telegramId,
        });
        markKnownLead(telegramId);
    } catch (err) {
        // 409 = lead already exists on the server
        if (err.response?.status === 409) markKnownLead(telegramId);
        // All other errors are silently swallowed — never disrupt UX
    }
}

// ── Leads list ─────────────────────────────────────────────────────────────────

async function sendLeadsList(bot, chatId, token, page = 1) {
    try {
        const res  = await api(token).get('/leads', { params: { page, limit: PAGE_SIZE } });
        const data = res.data;

        // Support both { leads, total, pages } and plain array
        const leads = Array.isArray(data) ? data : (data.leads || []);
        const pages = data.pages || Math.ceil((data.total || leads.length) / PAGE_SIZE) || 1;

        if (leads.length === 0) {
            return bot.sendMessage(chatId, '📭 Leadlar topilmadi.');
        }

        let text = `📋 <b>Leadlar ro'yxati</b>  (${page} / ${pages} sahifa)\n\n`;
        const buttons = leads.map((lead, i) => {
            const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Noma\'lum';
            text += `${(page - 1) * PAGE_SIZE + i + 1}. ${name} — ${fmtStatus(lead.status)}\n`;
            return [{ text: `👤 ${name}`, callback_data: `ld_${lead._id}` }];
        });

        // Pagination row
        const nav = [];
        if (page > 1)     nav.push({ text: '◀️ Oldingi', callback_data: `leads_p_${page - 1}` });
        if (page < pages) nav.push({ text: 'Keyingi ▶️', callback_data: `leads_p_${page + 1}` });
        if (nav.length)   buttons.push(nav);

        bot.sendMessage(chatId, text, {
            parse_mode:   'HTML',
            reply_markup: { inline_keyboard: buttons },
        });
    } catch (err) {
        handleApiError(bot, chatId, err);
    }
}

// ── Lead detail card ───────────────────────────────────────────────────────────

async function showLeadDetails(bot, query, token, leadId) {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    try {
        const res  = await api(token).get(`/leads/${leadId}`);
        const lead = res.data.lead || res.data;

        bot.editMessageText(fmtLead(lead), {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   'HTML',
            reply_markup: { inline_keyboard: actionButtons(leadId) },
        });
        bot.answerCallbackQuery(query.id);
    } catch (err) {
        bot.answerCallbackQuery(query.id, { text: '❌ Xatolik', show_alert: true });
        handleApiError(bot, chatId, err);
    }
}

// ── Status update ──────────────────────────────────────────────────────────────

async function updateLeadStatus(bot, query, token, leadId, status) {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    try {
        await api(token).put(`/leads/${leadId}`, { status });
        bot.answerCallbackQuery(query.id, { text: `✅ ${fmtStatus(status)}` });
        // Refresh the detail card
        showLeadDetails(bot, query, token, leadId);
    } catch (err) {
        bot.answerCallbackQuery(query.id, { text: '❌ Xatolik', show_alert: true });
        handleApiError(bot, chatId, err);
    }
}

// ── Convert flow ───────────────────────────────────────────────────────────────

/** Step 1 — show group selection keyboard. */
async function startConvertFlow(bot, query, token, leadId) {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    try {
        const res    = await api(token).get('/groups');
        const groups = res.data.groups || res.data || [];

        if (!groups.length) {
            return bot.answerCallbackQuery(query.id, {
                text:       '❌ Guruhlar topilmadi!',
                show_alert: true,
            });
        }

        // Show at most 20 groups to stay within message limits
        const buttons = groups.slice(0, 20).map(g => [{
            text:          `📚 ${g.name}`,
            callback_data: `lg_${leadId}_${g._id}`,
        }]);
        buttons.push([{ text: '◀️ Bekor qilish', callback_data: `ld_${leadId}` }]);

        bot.editMessageText(
            '📚 <b>Guruh tanlang:</b>\n\nLead qaysi guruhga qabul qilinadi?',
            {
                chat_id:      chatId,
                message_id:   msgId,
                parse_mode:   'HTML',
                reply_markup: { inline_keyboard: buttons },
            },
        );
        bot.answerCallbackQuery(query.id);
    } catch (err) {
        bot.answerCallbackQuery(query.id, { text: '❌ Xatolik', show_alert: true });
        handleApiError(bot, chatId, err);
    }
}

/** Step 2 — PUT /leads/{id} converted, then POST /enrollments. */
async function confirmEnrollment(bot, query, token, leadId, groupId) {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    try {
        // Convert the lead first; backend may return a student ID
        const convertRes = await api(token).put(`/leads/${leadId}`, { status: 'converted' });
        const studentId  = convertRes.data?.lead?.student || convertRes.data?.student || null;

        // Build enrollment payload — prefer student ID if the backend provided one
        const enrollPayload = studentId
            ? { student: studentId, group: groupId }
            : { lead: leadId,      group: groupId };

        await api(token).post('/enrollments', enrollPayload);

        bot.editMessageText(
            '✅ <b>Muvaffaqiyatli!</b>\n\nLead qabul qilindi va guruhga ro\'yxatga olindi.',
            {
                chat_id:    chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{
                        text:          '📋 Leadlar ro\'yxatiga qaytish',
                        callback_data: 'leads_p_1',
                    }]],
                },
            },
        );
        bot.answerCallbackQuery(query.id, { text: '✅ Muvaffaqiyatli!' });
    } catch (err) {
        bot.answerCallbackQuery(query.id, { text: '❌ Xatolik', show_alert: true });
        handleApiError(bot, chatId, err);
    }
}

// ── Callback router ────────────────────────────────────────────────────────────

/**
 * Call from the main callback_query handler.
 * Returns true if this module handled the query, false otherwise.
 */
async function handleLeadsCallback(bot, query) {
    const data    = query.data;
    const chatId  = query.message.chat.id;
    const token   = getToken(String(query.from.id));

    if (!token) {
        bot.answerCallbackQuery(query.id, {
            text:       '❌ Avval tizimga kiring!',
            show_alert: true,
        });
        return true;
    }

    // Pagination
    if (data.startsWith('leads_p_')) {
        const page = parseInt(data.split('_')[2], 10) || 1;
        await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        await sendLeadsList(bot, chatId, token, page);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    // Lead detail
    if (data.startsWith('ld_')) {
        await showLeadDetails(bot, query, token, data.slice(3));
        return true;
    }

    // Status: contacted / scheduled / rejected
    const STATUS_PREFIX = { lc_: 'contacted', ls_: 'scheduled', lr_: 'rejected' };
    for (const [prefix, status] of Object.entries(STATUS_PREFIX)) {
        if (data.startsWith(prefix)) {
            await updateLeadStatus(bot, query, token, data.slice(3), status);
            return true;
        }
    }

    // Convert — show group picker
    if (data.startsWith('lv_')) {
        await startConvertFlow(bot, query, token, data.slice(3));
        return true;
    }

    // Group selected for enrollment  lg_{leadId}_{groupId}
    if (data.startsWith('lg_')) {
        const rest      = data.slice(3);                      // '{leadId}_{groupId}'
        const sepIdx    = rest.indexOf('_');
        const leadId    = rest.slice(0, sepIdx);
        const groupId   = rest.slice(sepIdx + 1);
        await confirmEnrollment(bot, query, token, leadId, groupId);
        return true;
    }

    return false; // not a leads callback
}

// ── Command registration ───────────────────────────────────────────────────────

function registerLeadsHandlers(bot) {
    // /leads [page]
    bot.onText(/^\/leads(?:\s+(\d+))?$/, async (msg, match) => {
        const chatId = msg.chat.id;
        const token  = getToken(String(msg.from.id));

        if (!token) {
            return bot.sendMessage(
                chatId,
                '❌ Avval tizimga kiring!\n\n🔑 Format:\n`+998901234567 parol`',
                { parse_mode: 'Markdown' },
            );
        }

        const page = parseInt(match[1], 10) || 1;
        await sendLeadsList(bot, chatId, token, page);
    });
}

module.exports = { registerLeadsHandlers, handleLeadsCallback, autoCreateLead };
