require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const { readDB, writeDB, getSession, saveSession, removeSession } = require('./db');
const { mainMenuKeyboard, cancelKeyboard } = require('./keyboards');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
    polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});

const BACKEND = process.env.BACKEND_URL || 'https://api.bayyina.org.uz/api';
const ADMIN_IDS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(Number).filter(Boolean)
    : [];

const loginStates = new Map();

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

async function forceSub(chatId, userId) {
    const db = readDB();
    const buttons = (db.channels || []).map(ch => [{
        text: `📢 ${ch.channelId}`,
        url: `https://t.me/${ch.channelId.replace('@', '')}`,
    }]);
    buttons.push([{ text: '✅ Obunani tekshirish', callback_data: 'check_sub' }]);
    await bot.sendMessage(chatId,
        '👋 Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling:',
        { reply_markup: { inline_keyboard: buttons } }
    );
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const isSub = await checkSubscriptions(userId);
    if (!isSub) return forceSub(chatId, userId);

    const session = getSession(userId);
    const isAdmin = ADMIN_IDS.includes(userId);
    bot.sendMessage(chatId,
        '🎓 <b>Bayyina Ta\'lim Markazi</b>\n\nTizimga kirish uchun quyidagi tugmani bosing.',
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(session?.role, isAdmin) }
    );
});

// ─── Admin Channel Management ────────────────────────────────────────────────

bot.onText(/\/add\s+(.+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const channelId = match[1].trim();
    const db = readDB();
    if (!db.channels) db.channels = [];
    if (!db.channels.find(c => c.channelId === channelId)) {
        db.channels.push({ channelId });
        writeDB(db);
        bot.sendMessage(msg.chat.id, `✅ Kanal qo'shildi: ${channelId}`);
    } else {
        bot.sendMessage(msg.chat.id, `⚠️ Bu kanal allaqachon mavjud.`);
    }
});

bot.onText(/\/remove\s+(.+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const channelId = match[1].trim();
    const db = readDB();
    db.channels = (db.channels || []).filter(c => c.channelId !== channelId);
    writeDB(db);
    bot.sendMessage(msg.chat.id, `🗑 Kanal o'chirildi: ${channelId}`);
});

bot.onText(/\/list/, async (msg) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const db = readDB();
    const list = (db.channels || []).map(c => `📢 ${c.channelId}`).join('\n') || 'Kanal yo\'q.';
    bot.sendMessage(msg.chat.id, `📋 <b>Kanallar ro'yxati:</b>\n\n${list}`, { parse_mode: 'HTML' });
});

// ─── Message Handler ─────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    const isSub = await checkSubscriptions(userId);
    if (!isSub) return forceSub(chatId, userId);

    const lState = loginStates.get(chatId);
    if (!lState) return;

    if (lState.step === 'phone') {
        const phone = text.replace(/\D/g, '');
        if (phone.length < 9) return bot.sendMessage(chatId, '❌ Telefon raqam noto\'g\'ri. Qayta kiriting:', { reply_markup: cancelKeyboard() });
        lState.phone = phone;
        lState.step = 'password';
        loginStates.set(chatId, lState);
        return bot.sendMessage(chatId, '🔑 Parolingizni kiriting:', { reply_markup: cancelKeyboard() });
    }

    if (lState.step === 'password') {
        const password = text;
        const phone = lState.phone;
        loginStates.delete(chatId);
        bot.sendMessage(chatId, '⌛ Tekshirilmoqda...');
        try {
            const res = await axios.post(`${BACKEND}/auth/login`, { phone, password });
            const { token, user } = res.data;
            const role = user?.role || 'student';
            saveSession(userId, { token, role });
            // Save Telegram ID to server so admin can message this user
            axios.post(`${BACKEND}/auth/link-telegram`,
                { telegramId: String(userId) },
                { headers: { Authorization: `Bearer ${token}` } }
            ).catch(() => {});
            const isAdmin = ADMIN_IDS.includes(userId);
            bot.sendMessage(chatId, `✅ <b>Muvaffaqiyatli kirdingiz!</b>\n\nRol: <b>${role}</b>`, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(role, isAdmin) });
        } catch {
            bot.sendMessage(chatId, '❌ Login yoki parol xato. Qayta urinib ko\'ring: /login');
        }
    }
});

// ─── Callbacks ────────────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data === 'check_sub') {
        const isSub = await checkSubscriptions(userId);
        if (isSub) {
            bot.answerCallbackQuery(query.id, { text: '✅ Rahmat!' });
            bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
            const session = getSession(userId);
            const isAdmin = ADMIN_IDS.includes(userId);
            return bot.sendMessage(chatId, '🎓 <b>Bayyina Ta\'lim Markazi</b>', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(session?.role, isAdmin) });
        }
        return bot.answerCallbackQuery(query.id, { text: '❌ Obuna bo\'ling!', show_alert: true });
    }

    const isSub = await checkSubscriptions(userId);
    if (!isSub) {
        bot.answerCallbackQuery(query.id, { text: '❌ Avval obuna bo\'ling!', show_alert: true });
        return forceSub(chatId, userId);
    }

    if (data === 'flow_cancel') {
        bot.answerCallbackQuery(query.id);
        loginStates.delete(chatId);
        bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
        const session = getSession(userId);
        const isAdmin = ADMIN_IDS.includes(userId);
        return bot.sendMessage(chatId, '✋ Bekor qilindi.', { reply_markup: mainMenuKeyboard(session?.role, isAdmin) });
    }

    if (data === 'crm_login_start') {
        bot.answerCallbackQuery(query.id);
        loginStates.set(chatId, { step: 'phone' });
        return bot.sendMessage(chatId, '🔐 Telefon raqamingizni kiriting (+998...):', { reply_markup: cancelKeyboard() });
    }

    if (data === 'crm_logout') {
        bot.answerCallbackQuery(query.id, { text: '🚪 Chiqildi' });
        removeSession(userId);
        const isAdmin = ADMIN_IDS.includes(userId);
        return bot.editMessageReplyMarkup(mainMenuKeyboard(null, isAdmin), { chat_id: chatId, message_id: query.message.message_id });
    }
});

bot.onText(/\/login/, (msg) => {
    loginStates.set(msg.chat.id, { step: 'phone' });
    bot.sendMessage(msg.chat.id, '🔐 Telefonni kiriting:', { reply_markup: cancelKeyboard() });
});

bot.onText(/\/help/, (msg) => {
    const isAdmin = ADMIN_IDS.includes(msg.from.id);
    let text = '📋 <b>Buyruqlar:</b>\n\n/start - Botni boshlash\n/login - Tizimga kirish';
    if (isAdmin) {
        text += '\n\n🛠 <b>Admin buyruqlari:</b>\n/add @kanal - Kanal qo\'shish\n/remove @kanal - Kanalni o\'chirish\n/list - Kanallar ro\'yxati';
    }
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

console.log('🚀 Bayyina Bot ishga tushdi.');
