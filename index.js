require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');

const { readDB, writeDB, getToken, setToken } = require('./db');
const { mainMenuKeyboard, leadActionsKeyboard, paginationKeyboard } = require('./keyboards');
const { startFlow, cancelFlow, handleCourseSelect, handleGenderSelect, handleText, cancelReminder } = require('./flow');
const { getLeadsList, getLead, updateLeadStatus, getGroups, fmtStatus, fmtLead } = require('./leads');

const bot     = new TelegramBot(process.env.BOT_TOKEN, {
    polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});
const BACKEND   = process.env.BACKEND_URL || 'http://156.67.29.62:4000/api';
const ADMIN_IDS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(Number).filter(Boolean)
    : [];

// ─── Subscription check ───────────────────────────────────────────────────────

async function checkSubscriptions(userId) {
    const db = readDB();
    if (!db.channels || db.channels.length === 0) return true;
    for (const ch of db.channels) {
        try {
            const m = await bot.getChatMember(ch.channelId, userId);
            if (!['member', 'administrator', 'creator'].includes(m.status)) return false;
        } catch { return false; }
    }
    return true;
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId   = msg.chat.id;
    const userId   = msg.from.id;
    const deepLink = match[1]?.trim() || null;

    if (deepLink) {
        axios.get(`${BACKEND}/leads/track/${encodeURIComponent(deepLink)}`).catch(() => {});
    }

    const isSub = await checkSubscriptions(userId);
    if (!isSub) {
        const db = readDB();
        const buttons = (db.channels || []).map(ch => [{
            text: `📢 ${ch.channelId}`,
            url:  `https://t.me/${ch.channelId.replace('@', '')}`,
        }]);
        buttons.push([{ text: '✅ Obunani tekshirish', callback_data: 'check_sub' }]);
        return bot.sendMessage(chatId,
            '👋 Xush kelibsiz!\n\nBotdan foydalanish uchun quyidagi kanallarga obuna bo\'ling:',
            { reply_markup: { inline_keyboard: buttons } }
        );
    }

    bot.sendMessage(chatId,
        '🎓 <b>Bayyina Ta\'lim Markazi</b>\n\n' +
        'Salom! Kurslarimizdan biriga yozilish uchun quyidagi tugmani bosing.',
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
    );
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help|\/menu|\/commands/, (msg) => {
    const chatId  = msg.chat.id;
    const isAdmin = ADMIN_IDS.includes(msg.from.id);

    if (!isAdmin) {
        return bot.sendMessage(chatId,
            '📋 <b>Buyruqlar:</b>\n\n/start — Botni boshlash\n/help  — Yordam',
            { parse_mode: 'HTML' }
        );
    }

    bot.sendMessage(chatId,
        '🛠 <b>Admin buyruqlari:</b>\n\n' +
        '/leads         — Leadlar ro\'yxati\n' +
        '/add &lt;url&gt;  — Kanal qo\'shish\n' +
        '/remove @kanal — Kanal o\'chirish\n' +
        '/list          — Kanallar ro\'yxati',
        { parse_mode: 'HTML' }
    );
});

// ─── /leads ───────────────────────────────────────────────────────────────────

bot.onText(/^\/leads(?:\s+(\d+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const token = getToken(String(msg.from.id));
    if (!token) {
        return bot.sendMessage(chatId, '❌ Avval tizimga kiring:\n`+998901234567 parol`', { parse_mode: 'Markdown' });
    }
    const page = parseInt(match[1], 10) || 1;
    await sendLeadsList(chatId, msg.from.id, page);
});

async function sendLeadsList(chatId, fromId, page = 1) {
    const result = await getLeadsList(String(fromId), page);
    if (!result.success) {
        return bot.sendMessage(chatId, `❌ ${result.error === 'no_token' ? 'Avval tizimga kiring.' : result.error}`);
    }
    if (!result.leads.length) return bot.sendMessage(chatId, '📭 Leadlar topilmadi.');

    let text = `📋 <b>Leadlar</b> (${page}/${result.pages})\n\n`;
    const buttons = result.leads.map((lead, i) => {
        text += `${(page - 1) * 8 + i + 1}. <b>${lead.firstName}</b> — ${fmtStatus(lead.status)}\n`;
        return [{ text: `👤 ${lead.firstName}`, callback_data: `lead_view_${lead._id}` }];
    });

    const nav = paginationKeyboard(page, result.pages);
    if (nav) buttons.push(...nav.inline_keyboard);

    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

// ─── Callback queries ─────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const data       = query.data;
    const chatId     = query.message.chat.id;
    const userId     = query.from.id;
    const telegramId = String(userId);

    // ── Subscription check ────────────────────────────────────────────────────
    if (data === 'check_sub') {
        const ok = await checkSubscriptions(userId);
        if (ok) {
            bot.answerCallbackQuery(query.id, { text: '✅ Obuna tasdiqlandi!' });
            bot.sendMessage(chatId, '✅ Obuna tasdiqlandi!', { reply_markup: mainMenuKeyboard() });
        } else {
            bot.answerCallbackQuery(query.id, { text: '❌ Hali barcha kanallarga obuna bo\'lmadingiz!', show_alert: true });
        }
        return;
    }

    // ── Lead registration flow ────────────────────────────────────────────────
    if (data === 'flow_courses') {
        bot.answerCallbackQuery(query.id);
        startFlow(bot, chatId, telegramId);
        return;
    }
    if (data.startsWith('flow_course_')) {
        handleCourseSelect(bot, query, telegramId, data.replace('flow_course_', ''));
        return;
    }
    if (data.startsWith('flow_gender_')) {
        handleGenderSelect(bot, query, telegramId, data.replace('flow_gender_', ''));
        return;
    }
    if (data === 'flow_cancel') {
        bot.answerCallbackQuery(query.id);
        cancelFlow(bot, chatId, telegramId);
        return;
    }

    // ── Admin-only callbacks ──────────────────────────────────────────────────
    if (!ADMIN_IDS.includes(userId)) return bot.answerCallbackQuery(query.id);

    const token = getToken(telegramId);
    if (!token && (data.startsWith('lead_') || data.startsWith('leads_'))) {
        return bot.answerCallbackQuery(query.id, { text: '❌ Avval tizimga kiring!', show_alert: true });
    }

    if (data.startsWith('leads_list_')) {
        const page = parseInt(data.replace('leads_list_', ''), 10) || 1;
        bot.answerCallbackQuery(query.id);
        await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        await sendLeadsList(chatId, userId, page);
        return;
    }

    if (data.startsWith('lead_view_')) {
        const leadId = data.replace('lead_view_', '');
        const result = await getLead(leadId, telegramId);
        bot.answerCallbackQuery(query.id);
        if (!result.success) return bot.sendMessage(chatId, '❌ Lead topilmadi.');
        bot.editMessageText(fmtLead(result.lead), {
            chat_id: chatId, message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: leadActionsKeyboard(leadId),
        });
        return;
    }

    if (data.startsWith('lead_status_')) {
        const parts  = data.replace('lead_status_', '').split('_');
        const status = parts.pop();
        const leadId = parts.join('_');
        const result = await updateLeadStatus(leadId, status, telegramId);
        if (result.success) {
            bot.answerCallbackQuery(query.id, { text: `✅ ${fmtStatus(status)}` });
            if (status === 'contacted') cancelReminder(leadId);
            const fresh = await getLead(leadId, telegramId);
            if (fresh.success) {
                bot.editMessageText(fmtLead(fresh.lead), {
                    chat_id: chatId, message_id: query.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: leadActionsKeyboard(leadId),
                });
            }
        } else {
            bot.answerCallbackQuery(query.id, { text: '❌ Xatolik', show_alert: true });
        }
        return;
    }

    bot.answerCallbackQuery(query.id);
});

// ─── Text messages ────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId     = msg.chat.id;
    const telegramId = String(msg.from.id);
    const text       = msg.text.trim();

    // Lead flow
    const handled = await handleText(bot, msg);
    if (handled) return;

    // Admin login: +998901234567 parol
    const loginMatch = text.match(/^(\+?998\d{9})\s+(\S+)$/);
    if (loginMatch) {
        const phone    = loginMatch[1].replace('+', '');
        const password = loginMatch[2];
        try {
            const res = await axios.post(`${BACKEND}/auth/login`, {
                phone:      Number(phone),
                password,
                telegramId,
            });
            if (res.data.code === 'loginSuccess') {
                setToken(telegramId, res.data.token);
                bot.sendMessage(chatId,
                    `✅ Xush kelibsiz, <b>${res.data.user.firstName}</b>!\n\n` +
                    `Leadlarni ko'rish: /leads`,
                    { parse_mode: 'HTML' }
                );
            } else {
                bot.sendMessage(chatId, '❌ Login muvaffaqiyatsiz: ' + res.data.message);
            }
        } catch (err) {
            bot.sendMessage(chatId, '❌ ' + (err.response?.data?.message || err.message));
        }
    }
});

// ─── Channel management ───────────────────────────────────────────────────────

function extractUsername(input) {
    if (input.includes('t.me/')) return '@' + input.split('t.me/')[1].split('/')[0];
    if (input.startsWith('@')) return input;
    return '@' + input;
}

bot.onText(/^\/add(?:\s+(.+))?$/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const url = match[1];
    if (!url) return bot.sendMessage(msg.chat.id, 'Format: /add https://t.me/kanal');
    try {
        const channelId = extractUsername(url);
        await bot.getChat(channelId);
        const db = readDB();
        if (db.channels.some(c => c.channelId === channelId)) {
            return bot.sendMessage(msg.chat.id, '⚠️ Allaqachon qo\'shilgan.');
        }
        db.channels.push({ channelId });
        writeDB(db);
        bot.sendMessage(msg.chat.id, `✅ Kanal qo\'shildi: ${channelId}`);
    } catch {
        bot.sendMessage(msg.chat.id, '❌ Kanal topilmadi yoki bot admin emas!');
    }
});

bot.onText(/^\/remove\s+(.+)$/, (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const channelId = extractUsername(match[1].trim());
    const db = readDB();
    const before = db.channels.length;
    db.channels = db.channels.filter(c => c.channelId !== channelId);
    writeDB(db);
    bot.sendMessage(msg.chat.id, db.channels.length < before
        ? `🗑 Kanal o\'chirildi: ${channelId}`
        : `⚠️ Topilmadi: ${channelId}`);
});

bot.onText(/^\/list$/, (msg) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const db = readDB();
    if (!db.channels.length) return bot.sendMessage(msg.chat.id, '📭 Kanallar yo\'q');
    bot.sendMessage(msg.chat.id, '📢 Kanallar:\n' + db.channels.map(c => `• ${c.channelId}`).join('\n'));
});

// ─── Command suggestions ──────────────────────────────────────────────────────

const USER_COMMANDS = [
    { command: 'start', description: '🏠 Bosh menyu' },
    { command: 'help',  description: '📋 Yordam' },
];

const ADMIN_COMMANDS = [
    { command: 'start',  description: '🏠 Bosh menyu' },
    { command: 'help',   description: '📋 Yordam' },
    { command: 'leads',  description: '📥 Leadlar ro\'yxati' },
    { command: 'list',   description: '📢 Kanallar ro\'yxati' },
    { command: 'add',    description: '➕ Kanal qo\'shish' },
    { command: 'remove', description: '🗑 Kanal o\'chirish' },
];

bot.getMe().then(() => {
    bot.setMyCommands(USER_COMMANDS).catch(() => {});
    for (const adminId of ADMIN_IDS) {
        bot.setMyCommands(ADMIN_COMMANDS, {
            scope: { type: 'chat', chat_id: adminId },
        }).catch(() => {});
    }
});

// ─── Error handlers ───────────────────────────────────────────────────────────

let _restarting = false;
bot.on('polling_error', (err) => {
    console.error(`[polling_error] ${err.code ?? 'ERR'}: ${err.message}`);
    if (err.code === 'EFATAL' && !_restarting) {
        _restarting = true;
        bot.stopPolling().finally(() => {
            setTimeout(() => {
                _restarting = false;
                bot.startPolling().catch((e) => console.error('Restart xatosi:', e.message));
            }, 5000);
        });
    }
});

bot.on('error', (err) => console.error('[bot_error]', err.message));

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.message : String(reason));
});

console.log('🤖 Bayyina Bot ishga tushdi...');
