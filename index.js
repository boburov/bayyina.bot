require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const { readDB, writeDB, getSession, saveSession, removeSession } = require('./db');
const { mainMenuKeyboard, cancelKeyboard } = require('./keyboards');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
    polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});

const BACKEND = process.env.BACKEND_URL || 'https://api.bayyina.org.uz/api';

// ENV da yozilgan adminlar — superadmin, o'chirib bo'lmaydi
const ENV_ADMIN_IDS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(Number).filter(Boolean)
    : [];

// ─── Admin helpers ────────────────────────────────────────────────────────────

function getAdmins() {
    const db = readDB();
    const dbAdmins = (db.admins || []).map(Number).filter(Boolean);
    return [...new Set([...ENV_ADMIN_IDS, ...dbAdmins])];
}

function isAdmin(userId) {
    return getAdmins().includes(Number(userId));
}

function addAdmin(telegramId) {
    const db = readDB();
    if (!db.admins) db.admins = [];
    const id = String(telegramId);
    if (!db.admins.includes(id)) {
        db.admins.push(id);
        writeDB(db);
    }
}

function removeAdmin(telegramId) {
    if (ENV_ADMIN_IDS.includes(Number(telegramId))) return false; // superadminni o'chirish mumkin emas
    const db = readDB();
    db.admins = (db.admins || []).filter(id => id !== String(telegramId));
    writeDB(db);
    return true;
}

// ─── Bot channel-admin check ──────────────────────────────────────────────────

async function isBotAdminInChannel(channelId) {
    try {
        const me = await bot.getMe();
        const member = await bot.getChatMember(channelId, me.id);
        return ['administrator', 'creator'].includes(member.status);
    } catch { return false; }
}

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

async function forceSub(chatId) {
    const db = readDB();
    const buttons = (db.channels || []).map(ch => [{
        text: `📢 ${ch.title || ch.channelId}`,
        url: `https://t.me/${ch.channelId.replace('@', '')}`,
    }]);
    buttons.push([{ text: '✅ Obunani tekshirish', callback_data: 'check_sub' }]);
    await bot.sendMessage(chatId,
        '👋 <b>Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling:</b>',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
}

// ─── Admin panel keyboards ────────────────────────────────────────────────────

function adminPanelKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📢 Kanallar', callback_data: 'adm_channels' }, { text: '👤 Adminlar', callback_data: 'adm_admins' }],
            [{ text: '❌ Yopish', callback_data: 'adm_close' }],
        ],
    };
}

function channelsKeyboard(channels) {
    const rows = channels.map(ch => [{
        text: `🗑 ${ch.title || ch.channelId}`,
        callback_data: `adm_ch_del:${ch.channelId}`,
    }]);
    rows.push([{ text: '➕ Kanal qo\'shish', callback_data: 'adm_ch_add' }]);
    rows.push([{ text: '🔙 Orqaga', callback_data: 'adm_back' }]);
    return { inline_keyboard: rows };
}

function adminsKeyboard(admins) {
    const rows = admins.map(id => {
        const isSuperAdmin = ENV_ADMIN_IDS.includes(Number(id));
        return [{
            text: `${isSuperAdmin ? '👑' : '👤'} ${id}${isSuperAdmin ? ' (asosiy)' : ''}`,
            callback_data: isSuperAdmin ? 'adm_noop' : `adm_admin_del:${id}`,
        }];
    });
    rows.push([{ text: '➕ Admin qo\'shish', callback_data: 'adm_admin_add' }]);
    rows.push([{ text: '🔙 Orqaga', callback_data: 'adm_back' }]);
    return { inline_keyboard: rows };
}

function adminCancelKeyboard() {
    return { inline_keyboard: [[{ text: '❌ Bekor qilish', callback_data: 'adm_input_cancel' }]] };
}

// ─── Admin state machine ──────────────────────────────────────────────────────
// step: 'ch_add' | 'admin_add'

const adminStates = new Map();
const loginStates = new Map();

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const isSub = await checkSubscriptions(userId);
    if (!isSub) return forceSub(chatId);

    const session = getSession(userId);
    bot.sendMessage(chatId,
        '🎓 <b>Bayyina Ta\'lim Markazi</b>\n\nTizimga kirish uchun quyidagi tugmani bosing.',
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(session?.role, isAdmin(userId)) }
    );
});

// ─── /admin ───────────────────────────────────────────────────────────────────

bot.onText(/\/admin/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const db = readDB();
    const chCount = (db.channels || []).length;
    const admCount = getAdmins().length;
    bot.sendMessage(msg.chat.id,
        `🔐 <b>Admin Panel</b>\n\n📢 Kanallar: <b>${chCount}</b>\n👤 Adminlar: <b>${admCount}</b>`,
        { parse_mode: 'HTML', reply_markup: adminPanelKeyboard() }
    );
});

// ─── /login ───────────────────────────────────────────────────────────────────

bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isSub = await checkSubscriptions(userId);
    if (!isSub) return forceSub(chatId);
    loginStates.set(chatId, { step: 'phone' });
    bot.sendMessage(chatId, '🔐 Telefonni kiriting:', { reply_markup: cancelKeyboard() });
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, (msg) => {
    let text = '📋 <b>Buyruqlar:</b>\n\n/start — Botni boshlash\n/login — Tizimga kirish';
    if (isAdmin(msg.from.id)) {
        text += '\n\n🛠 <b>Admin buyruqlari:</b>\n/admin — Admin panel';
    }
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    // ── Admin input flows ──────────────────────────────────────────────────────
    const aState = adminStates.get(chatId);
    if (aState && isAdmin(userId)) {
        adminStates.delete(chatId);

        if (aState.step === 'ch_add') {
            const channelId = text.startsWith('@') ? text.trim() : '@' + text.trim();
            const db = readDB();
            if (!db.channels) db.channels = [];

            if (db.channels.find(c => c.channelId === channelId)) {
                return bot.sendMessage(chatId, '⚠️ Bu kanal allaqachon qo\'shilgan.', { reply_markup: adminPanelKeyboard() });
            }

            // Check bot admin rights
            const botIsAdmin = await isBotAdminInChannel(channelId);
            let title = channelId;
            try {
                const chat = await bot.getChat(channelId);
                title = chat.title || channelId;
            } catch { /* ignore */ }

            db.channels.push({ channelId, title });
            writeDB(db);

            let replyText = `✅ Kanal qo'shildi: <b>${title}</b>`;
            if (!botIsAdmin) {
                replyText += '\n\n⚠️ <b>Diqqat!</b> Bot bu kanalda <b>admin emas</b>!\nObunani tekshirish ishlamaydi — botni kanalga admin qiling.';
            }
            return bot.sendMessage(chatId, replyText, {
                parse_mode: 'HTML',
                reply_markup: channelsKeyboard(db.channels),
            });
        }

        if (aState.step === 'admin_add') {
            const newId = Number(text.trim());
            if (!newId || isNaN(newId)) {
                return bot.sendMessage(chatId,
                    '❌ Noto\'g\'ri Telegram ID. Faqat raqam kiriting.',
                    { reply_markup: adminCancelKeyboard() }
                );
            }

            if (isAdmin(newId)) {
                return bot.sendMessage(chatId, '⚠️ Bu foydalanuvchi allaqachon admin.', { reply_markup: adminPanelKeyboard() });
            }

            addAdmin(newId);

            // Notify new admin
            bot.sendMessage(newId,
                '🎉 <b>Tabriklaymiz!</b>\n\nSiz Bayyina botining admini bo\'ldingiz!\n\n/admin — Admin panelni ochish',
                { parse_mode: 'HTML' }
            ).catch(() => {});

            return bot.sendMessage(chatId,
                `✅ Admin qo'shildi: <code>${newId}</code>\nUnga xabar yuborildi.`,
                { parse_mode: 'HTML', reply_markup: adminPanelKeyboard() }
            );
        }

        return;
    }

    // ── Subscription check ────────────────────────────────────────────────────
    const isSub = await checkSubscriptions(userId);
    if (!isSub) return forceSub(chatId);

    // ── Login flow ────────────────────────────────────────────────────────────
    const lState = loginStates.get(chatId);
    if (!lState) return;

    if (lState.step === 'phone') {
        const phone = text.replace(/\D/g, '');
        if (phone.length < 9) {
            return bot.sendMessage(chatId, '❌ Telefon raqam noto\'g\'ri. Qayta kiriting:', { reply_markup: cancelKeyboard() });
        }
        lState.phone = phone;
        lState.step = 'password';
        loginStates.set(chatId, lState);
        return bot.sendMessage(chatId, '🔑 Parolingizni kiriting:', { reply_markup: cancelKeyboard() });
    }

    if (lState.step === 'password') {
        const password = text;
        const phone = lState.phone;
        loginStates.delete(chatId);
        const loadMsg = await bot.sendMessage(chatId, '⌛ Tekshirilmoqda...');
        try {
            const res = await axios.post(`${BACKEND}/auth/login`, { phone, password });
            const { token, user } = res.data;
            const role = user?.role || 'student';
            saveSession(userId, { token, role });
            axios.post(`${BACKEND}/auth/link-telegram`,
                { telegramId: String(userId) },
                { headers: { Authorization: `Bearer ${token}` } }
            ).catch(() => {});
            bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
            bot.sendMessage(chatId,
                `✅ <b>Muvaffaqiyatli kirdingiz!</b>\n\nRol: <b>${role}</b>`,
                { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(role, isAdmin(userId)) }
            );
        } catch {
            bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
            bot.sendMessage(chatId, '❌ Login yoki parol xato. Qayta urinib ko\'ring: /login');
        }
    }
});

// ─── Callbacks ────────────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data   = query.data;
    const msgId  = query.message.message_id;

    // ── Subscription check callback ───────────────────────────────────────────
    if (data === 'check_sub') {
        const isSub = await checkSubscriptions(userId);
        if (isSub) {
            bot.answerCallbackQuery(query.id, { text: '✅ Rahmat!' });
            bot.deleteMessage(chatId, msgId).catch(() => {});
            const session = getSession(userId);
            return bot.sendMessage(chatId,
                '🎓 <b>Bayyina Ta\'lim Markazi</b>',
                { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(session?.role, isAdmin(userId)) }
            );
        }
        return bot.answerCallbackQuery(query.id, { text: '❌ Obuna bo\'ling!', show_alert: true });
    }

    // ── Admin panel callbacks ─────────────────────────────────────────────────
    if (data.startsWith('adm_')) {
        if (!isAdmin(userId)) {
            return bot.answerCallbackQuery(query.id, { text: '⛔ Ruxsat yo\'q', show_alert: true });
        }
        bot.answerCallbackQuery(query.id);

        if (data === 'adm_close') {
            return bot.deleteMessage(chatId, msgId).catch(() => {});
        }

        if (data === 'adm_back') {
            const db = readDB();
            const chCount = (db.channels || []).length;
            const admCount = getAdmins().length;
            return bot.editMessageText(
                `🔐 <b>Admin Panel</b>\n\n📢 Kanallar: <b>${chCount}</b>\n👤 Adminlar: <b>${admCount}</b>`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminPanelKeyboard() }
            );
        }

        if (data === 'adm_noop') return;

        if (data === 'adm_channels') {
            const db = readDB();
            const channels = db.channels || [];
            const text = channels.length
                ? `📢 <b>Kanallar (${channels.length} ta)</b>\n\nO'chirish uchun kanalga bosing:`
                : '📢 <b>Kanallar</b>\n\nHozircha kanal qo\'shilmagan.';
            return bot.editMessageText(text, {
                chat_id: chatId, message_id: msgId,
                parse_mode: 'HTML', reply_markup: channelsKeyboard(channels),
            });
        }

        if (data === 'adm_ch_add') {
            adminStates.set(chatId, { step: 'ch_add' });
            return bot.editMessageText(
                '📢 <b>Kanal qo\'shish</b>\n\nKanal username kiriting:\n<i>Misol: @bayyina_uz</i>\n\n⚠️ Bot kanalda <b>admin bo\'lishi shart</b>, aks holda obunani tekshira olmaydi.',
                { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminCancelKeyboard() }
            );
        }

        if (data.startsWith('adm_ch_del:')) {
            const channelId = data.replace('adm_ch_del:', '');
            const db = readDB();
            db.channels = (db.channels || []).filter(c => c.channelId !== channelId);
            writeDB(db);
            const text = db.channels.length
                ? `📢 <b>Kanallar (${db.channels.length} ta)</b>\n\n✅ ${channelId} o'chirildi.`
                : '📢 <b>Kanallar</b>\n\nHozircha kanal qo\'shilmagan.';
            return bot.editMessageText(text, {
                chat_id: chatId, message_id: msgId,
                parse_mode: 'HTML', reply_markup: channelsKeyboard(db.channels),
            });
        }

        if (data === 'adm_admins') {
            const admins = getAdmins();
            const text = `👤 <b>Adminlar (${admins.length} ta)</b>\n\n👑 = asosiy (o'chirib bo'lmaydi)\n\nO'chirish uchun admin ustiga bosing:`;
            return bot.editMessageText(text, {
                chat_id: chatId, message_id: msgId,
                parse_mode: 'HTML', reply_markup: adminsKeyboard(admins),
            });
        }

        if (data === 'adm_admin_add') {
            adminStates.set(chatId, { step: 'admin_add' });
            return bot.editMessageText(
                '👤 <b>Admin qo\'shish</b>\n\nYangi adminning <b>Telegram ID</b> sini kiriting:\n<i>(Foydalanuvchi botga /start bosishi kerak yoki IDni bilib olishi kerak)</i>',
                { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminCancelKeyboard() }
            );
        }

        if (data.startsWith('adm_admin_del:')) {
            const delId = data.replace('adm_admin_del:', '');
            const removed = removeAdmin(delId);
            if (!removed) {
                return bot.answerCallbackQuery(query.id, { text: '⛔ Asosiy adminni o\'chirib bo\'lmaydi', show_alert: true });
            }
            bot.sendMessage(Number(delId),
                '⚠️ Sizning admin huquqingiz bekor qilindi.'
            ).catch(() => {});
            const admins = getAdmins();
            return bot.editMessageText(
                `👤 <b>Adminlar (${admins.length} ta)</b>\n\n✅ <code>${delId}</code> o'chirildi.`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminsKeyboard(admins) }
            );
        }

        if (data === 'adm_input_cancel') {
            adminStates.delete(chatId);
            const db = readDB();
            const chCount = (db.channels || []).length;
            const admCount = getAdmins().length;
            return bot.editMessageText(
                `🔐 <b>Admin Panel</b>\n\n📢 Kanallar: <b>${chCount}</b>\n👤 Adminlar: <b>${admCount}</b>`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminPanelKeyboard() }
            );
        }

        return;
    }

    // ── User callbacks ────────────────────────────────────────────────────────
    const isSub = await checkSubscriptions(userId);
    if (!isSub) {
        bot.answerCallbackQuery(query.id, { text: '❌ Avval obuna bo\'ling!', show_alert: true });
        return forceSub(chatId);
    }

    if (data === 'flow_cancel') {
        bot.answerCallbackQuery(query.id);
        loginStates.delete(chatId);
        bot.deleteMessage(chatId, msgId).catch(() => {});
        const session = getSession(userId);
        return bot.sendMessage(chatId, '✋ Bekor qilindi.', { reply_markup: mainMenuKeyboard(session?.role, isAdmin(userId)) });
    }

    if (data === 'crm_login_start') {
        bot.answerCallbackQuery(query.id);
        loginStates.set(chatId, { step: 'phone' });
        return bot.sendMessage(chatId, '🔐 Telefon raqamingizni kiriting (+998...):', { reply_markup: cancelKeyboard() });
    }

    if (data === 'crm_logout') {
        bot.answerCallbackQuery(query.id, { text: '🚪 Chiqildi' });
        removeSession(userId);
        return bot.editMessageReplyMarkup(mainMenuKeyboard(null, isAdmin(userId)), { chat_id: chatId, message_id: msgId });
    }
});

console.log('🚀 Bayyina Bot ishga tushdi.');
