require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const { readDB, writeDB, getToken, setToken, getSession, saveSession, removeSession } = require('./db');
const { mainMenuKeyboard, adminCoursesKeyboard, leadActionsKeyboard, paginationKeyboard, cancelKeyboard } = require('./keyboards');
const { startFlow, cancelFlow, handleCourseSelect, handleGenderSelect, handleText } = require('./flow');
const { getLeadsList, updateLeadStatus, fmtLead } = require('./leads');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
    polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});

const BACKEND = process.env.BACKEND_URL || 'http://api.bayyina.org.uz/api';
const ADMIN_IDS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(Number).filter(Boolean)
    : [];

const loginStates = new Map();
const adminStates = new Map();

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

// ─── Course Helpers ───────────────────────────────────────────────────────────

function getCourses() {
    try {
        const data = fs.readFileSync('./data/courses.json', 'utf8');
        return JSON.parse(data);
    } catch (e) { return []; }
}

function saveCourses(courses) {
    fs.writeFileSync('./data/courses.json', JSON.stringify(courses, null, 2));
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const deepLink = match[1]?.trim() || null;

    if (deepLink) {
        axios.get(`${BACKEND}/leads/track/${encodeURIComponent(deepLink)}`).catch(() => { });
    }

    const isSub = await checkSubscriptions(userId);
    if (!isSub) return forceSub(chatId, userId);

    const session = getSession(userId);
    const isAdmin = ADMIN_IDS.includes(userId);
    bot.sendMessage(chatId,
        '🎓 <b>Bayyina Ta\'lim Markazi</b>\n\n' +
        'Salom! Kurslarimizdan biriga yozilish uchun quyidagi tugmani bosing.',
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(session?.role, isAdmin) }
    );
});

// ─── Admin Channel Management ────────────────────────────────────────────────

bot.onText(/\/add\s+(.+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const channelId = match[1].trim(); w
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

    // Subscription check for any message
    const isSub = await checkSubscriptions(userId);
    if (!isSub) return forceSub(chatId, userId);

    // Admin Course Addition
    const aState = adminStates.get(chatId);
    if (aState && aState.step === 'add_course') {
        const label = text.trim();
        const id = label.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const courses = getCourses();
        courses.push({ id, label });
        saveCourses(courses);
        adminStates.delete(chatId);
        return bot.sendMessage(chatId, `✅ Yangi kurs qo'shildi: <b>${label}</b>`, { parse_mode: 'HTML', reply_markup: adminCoursesKeyboard() });
    }

    // Handle Login flow
    const lState = loginStates.get(chatId);
    if (lState) {
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
                const isAdmin = ADMIN_IDS.includes(userId);
                bot.sendMessage(chatId, `✅ <b>Muvaffaqiyatli kirdingiz!</b>\n\nRol: <b>${role}</b>`, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(role, isAdmin) });
            } catch (err) { bot.sendMessage(chatId, '❌ Login yoki parol xato. Qayta urinib ko\'ring: /login'); }
            return;
        }
    }

    const handled = await handleText(bot, msg);
    if (handled) return;
});

// ─── Callbacks ────────────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    // Exception for check_sub
    if (data === 'check_sub') {
        const isSub = await checkSubscriptions(userId);
        if (isSub) {
            bot.answerCallbackQuery(query.id, { text: '✅ Rahmat!' });
            bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
            const session = getSession(userId);
            const isAdmin = ADMIN_IDS.includes(userId);
            return bot.sendMessage(chatId, '🎓 <b>Bayyina Ta\'lim Markazi</b>', { reply_markup: mainMenuKeyboard(session?.role, isAdmin) });
        }
        return bot.answerCallbackQuery(query.id, { text: '❌ Obuna bo\'ling!', show_alert: true });
    }

    // Subscription check for any other callback
    const isSub = await checkSubscriptions(userId);
    if (!isSub) {
        bot.answerCallbackQuery(query.id, { text: '❌ Avval obuna bo\'ling!', show_alert: true });
        return forceSub(chatId, userId);
    }

    if (data === 'flow_courses') {
        bot.answerCallbackQuery(query.id);
        return startFlow(bot, chatId, userId);
    }

    if (data === 'flow_cancel') {
        bot.answerCallbackQuery(query.id);
        loginStates.delete(chatId);
        adminStates.delete(chatId);
        bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
        return cancelFlow(bot, chatId, userId);
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

    if (data === 'admin_courses_mgmt') {
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, '🛠 <b>Kurslarni boshqarish menyusi:</b>', { parse_mode: 'HTML', reply_markup: adminCoursesKeyboard() });
    }

    if (data === 'admin_course_add') {
        bot.answerCallbackQuery(query.id);
        adminStates.set(chatId, { step: 'add_course' });
        return bot.sendMessage(chatId, '📝 <b>Yangi kurs nomini kiriting:</b>', { reply_markup: cancelKeyboard() });
    }

    if (data.startsWith('admin_course_del_')) {
        const id = data.replace('admin_course_del_', '');
        let courses = getCourses();
        courses = courses.filter(c => c.id !== id);
        saveCourses(courses);
        bot.answerCallbackQuery(query.id, { text: '🗑 O\'chirildi' });
        return bot.editMessageReplyMarkup(adminCoursesKeyboard(), { chat_id: chatId, message_id: query.message.message_id });
    }

    if (data === 'admin_back') {
        bot.answerCallbackQuery(query.id);
        bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
        const session = getSession(userId);
        const isAdmin = ADMIN_IDS.includes(userId);
        return bot.sendMessage(chatId, '🎓 <b>Asosiy menyu</b>', { reply_markup: mainMenuKeyboard(session?.role, isAdmin) });
    }

    if (data.startsWith('flow_course_')) {
        return handleCourseSelect(bot, query, userId, data.replace('flow_course_', ''));
    }

    if (data.startsWith('flow_gender_')) {
        return handleGenderSelect(bot, query, userId, data.replace('flow_gender_', ''));
    }

    if (data.startsWith('lead_status_')) {
        const [, , leadId, status] = data.split('_');
        const res = await updateLeadStatus(leadId, status, userId);
        if (res.success) {
            bot.answerCallbackQuery(query.id, { text: '✅' });
            bot.editMessageText(fmtLead(res.lead), { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: leadActionsKeyboard(leadId) });
        }
    }

    if (data.startsWith('leads_list_')) {
        bot.answerCallbackQuery(query.id);
        const page = parseInt(data.replace('leads_list_', '')) || 1;
        const res = await getLeadsList(userId, page);
        if (res.success && res.leads.length > 0) {
            for (const lead of res.leads) await bot.sendMessage(chatId, fmtLead(lead), { parse_mode: 'HTML', reply_markup: leadActionsKeyboard(lead._id) });
            const kb = paginationKeyboard(page, res.pages);
            if (kb) bot.sendMessage(chatId, `Sahifa ${page} / ${res.pages}`, { reply_markup: kb });
        }
    }
});

bot.onText(/\/login/, (msg) => {
    loginStates.set(msg.chat.id, { step: 'phone' });
    bot.sendMessage(msg.chat.id, '🔐 Telefonni kiriting:', { reply_markup: cancelKeyboard() });
});

bot.onText(/^\/leads(?:\s+(\d+))?$/, async (msg, match) => {
    const page = parseInt(match[1], 10) || 1;
    const res = await getLeadsList(msg.from.id, page);
    if (res.success && res.leads.length > 0) {
        for (const lead of res.leads) await bot.sendMessage(msg.chat.id, fmtLead(lead), { parse_mode: 'HTML', reply_markup: leadActionsKeyboard(lead._id) });
        const kb = paginationKeyboard(page, res.pages);
        if (kb) bot.sendMessage(msg.chat.id, `Sahifa ${page} / ${res.pages}`, { reply_markup: kb });
    }
});

bot.onText(/\/help/, (msg) => {
    const isAdmin = ADMIN_IDS.includes(msg.from.id);
    let text = "📋 <b>Buyruqlar:</b>\n\n/start - Botni boshlash\n/login - Tizimga ga kirish";
    if (isAdmin) {
        text += "\n\n🛠 <b>Admin buyruqlari:</b>\n/add @kanal - Kanal qo'shish\n/remove @kanal - Kanalni o'chirish\n/list - Kanallar ro'yxati\n/leads - Leadlar ro'yxati";
    }
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

console.log('🚀 Bayyina Bot is running with Global Subscription Check...');
