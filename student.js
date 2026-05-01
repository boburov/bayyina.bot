require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.STUDENT_BOT_TOKEN;
if (!TOKEN) {
    console.error('❌ STUDENT_BOT_TOKEN topilmadi. .env faylini tekshiring.');
    process.exit(1);
}

const BACKEND = process.env.BACKEND_URL || 'https://api.bayyina.org.uz/api';
const ADMIN_IDS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(Number).filter(Boolean)
    : [];

const bot = new TelegramBot(TOKEN, {
    polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});

// ─── Session store ────────────────────────────────────────────────────────────

const SESSIONS_FILE = './data/student_sessions.json';

function readSessions() {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return {};
        return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch { return {}; }
}

function writeSessions(s) {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2));
}

function getSession(uid) { return readSessions()[String(uid)] || null; }

function saveSession(uid, data) {
    const s = readSessions();
    s[String(uid)] = { ...data, updatedAt: new Date().toISOString() };
    writeSessions(s);
}

function removeSession(uid) {
    const s = readSessions();
    delete s[String(uid)];
    writeSessions(s);
}

// ─── DB helpers (channels) — shares db.json with main bot ────────────────────

const DB_FILE = './db.json';

function readDB() {
    try {
        const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!d.studentChannels) d.studentChannels = [];
        return d;
    } catch { return { studentChannels: [] }; }
}

function writeDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

// ─── Subscription check ───────────────────────────────────────────────────────

async function checkSubs(userId) {
    const db = readDB();
    const channels = db.studentChannels || [];
    if (!channels.length) return true;
    for (const ch of channels) {
        try {
            const m = await bot.getChatMember(ch.channelId, userId);
            if (!['member', 'administrator', 'creator'].includes(m.status)) return false;
        } catch { return false; }
    }
    return true;
}

async function sendSubWall(chatId) {
    const db = readDB();
    const channels = db.studentChannels || [];
    const btns = channels.map(ch => [{
        text: `📢 ${ch.title || ch.channelId}`,
        url: `https://t.me/${ch.channelId.replace('@', '')}`,
    }]);
    btns.push([{ text: '✅ Obunani tekshirish', callback_data: 'check_sub' }]);
    await bot.sendMessage(chatId,
        '📢 <b>Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling:</b>',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: btns } }
    );
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

function loggedInKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '👤 Profilim', callback_data: 'profile' },  { text: '📚 Guruhlarim', callback_data: 'groups' }],
            [{ text: '🚪 Chiqish',  callback_data: 'logout' }],
        ],
    };
}

function guestKeyboard() {
    return {
        inline_keyboard: [[{ text: '🔑 Tizimga kirish', callback_data: 'login_start' }]],
    };
}

function cancelKeyboard() {
    return { inline_keyboard: [[{ text: '❌ Bekor qilish', callback_data: 'cancel' }]] };
}

// ─── Set bot commands (shown in Telegram menu) ────────────────────────────────

bot.setMyCommands([
    { command: 'start',   description: 'Botni boshlash' },
    { command: 'login',   description: 'Tizimga kirish' },
    { command: 'profile', description: 'Mening profilim' },
    { command: 'groups',  description: 'Mening guruhlarim' },
    { command: 'logout',  description: 'Tizimdan chiqish' },
    { command: 'help',    description: 'Yordam va buyruqlar' },
]).catch(() => {});

// ─── Login state machine ──────────────────────────────────────────────────────

const loginStates = new Map();

// ─── Helper: send home message ────────────────────────────────────────────────

function sendHome(chatId, session, extra = '') {
    if (session) {
        const name = session.firstName ? `<b>${session.firstName}</b>` : 'o\'quvchi';
        bot.sendMessage(chatId,
            `${extra}👋 Xush kelibsiz, ${name}!\n\n` +
            `🎓 Siz tizimga kirgansiz.\n\n` +
            `📋 <b>Mavjud buyruqlar:</b>\n` +
            `/profile — Mening profilim\n` +
            `/groups — Mening guruhlarim\n` +
            `/logout — Tizimdan chiqish\n` +
            `/help — Yordam`,
            { parse_mode: 'HTML', reply_markup: loggedInKeyboard() }
        );
    } else {
        bot.sendMessage(chatId,
            `🎓 <b>Bayyina Ta'lim Markazi</b>\n\n` +
            `Tizimga kirish uchun quyidagi tugmani bosing yoki /login buyrug'ini yuboring.\n\n` +
            `📋 <b>Buyruqlar:</b>\n` +
            `/login — Tizimga kirish\n` +
            `/help — Yordam`,
            { parse_mode: 'HTML', reply_markup: guestKeyboard() }
        );
    }
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const ok = await checkSubs(userId);
    if (!ok) return sendSubWall(chatId);

    sendHome(chatId, getSession(userId));
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, (msg) => {
    const session = getSession(msg.from.id);
    const loggedIn = !!session;

    const lines = [
        '📋 <b>Barcha buyruqlar:</b>',
        '',
        '/start — Botni boshlash',
        '/login — Tizimga kirish',
    ];

    if (loggedIn) {
        lines.push('/profile — Mening profilim');
        lines.push('/groups — Mening guruhlarim');
        lines.push('/logout — Tizimdan chiqish');
    }

    lines.push('', '/help — Ushbu yordam xabari');

    if (ADMIN_IDS.includes(msg.from.id)) {
        lines.push('', '🛠 <b>Admin (kanal boshqaruvi):</b>');
        lines.push('/sadd @kanal — Kanal qo\'shish');
        lines.push('/sremove @kanal — Kanalni o\'chirish');
        lines.push('/slist — Kanallar ro\'yxati');
    }

    bot.sendMessage(msg.chat.id, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: loggedIn ? loggedInKeyboard() : guestKeyboard(),
    });
});

// ─── /login ───────────────────────────────────────────────────────────────────

bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const ok = await checkSubs(userId);
    if (!ok) return sendSubWall(chatId);

    if (getSession(userId)) {
        return bot.sendMessage(chatId,
            '✅ Siz allaqachon tizimdasiz.\n\nChiqish uchun /logout yuboring.',
            { reply_markup: loggedInKeyboard() }
        );
    }

    loginStates.set(chatId, { step: 'phone' });
    bot.sendMessage(chatId,
        '🔐 <b>Tizimga kirish</b>\n\nTelefon raqamingizni kiriting:\n<i>Misol: 998901234567</i>',
        { parse_mode: 'HTML', reply_markup: cancelKeyboard() }
    );
});

// ─── /profile ─────────────────────────────────────────────────────────────────

bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const ok = await checkSubs(userId);
    if (!ok) return sendSubWall(chatId);

    await showProfile(chatId, userId);
});

// ─── /groups ──────────────────────────────────────────────────────────────────

bot.onText(/\/groups/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const ok = await checkSubs(userId);
    if (!ok) return sendSubWall(chatId);

    await showGroups(chatId, userId);
});

// ─── /logout ──────────────────────────────────────────────────────────────────

bot.onText(/\/logout/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!getSession(userId)) {
        return bot.sendMessage(chatId, 'Siz hali tizimga kirmagansiz.', { reply_markup: guestKeyboard() });
    }

    removeSession(userId);
    bot.sendMessage(chatId,
        '🚪 Tizimdan chiqildi.\n\nQayta kirish uchun /login yuboring.',
        { reply_markup: guestKeyboard() }
    );
});

// ─── Admin: channel management ────────────────────────────────────────────────

bot.onText(/\/sadd\s+(.+)/, (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const channelId = match[1].trim();
    const db = readDB();
    if (!db.studentChannels) db.studentChannels = [];
    if (db.studentChannels.find(c => c.channelId === channelId)) {
        return bot.sendMessage(msg.chat.id, '⚠️ Bu kanal allaqachon mavjud.');
    }
    bot.getChat(channelId).then(chat => {
        db.studentChannels.push({ channelId, title: chat.title || channelId });
        writeDB(db);
        bot.sendMessage(msg.chat.id, `✅ Kanal qo'shildi: <b>${chat.title || channelId}</b>`, { parse_mode: 'HTML' });
    }).catch(() => {
        db.studentChannels.push({ channelId, title: channelId });
        writeDB(db);
        bot.sendMessage(msg.chat.id, `✅ Kanal qo'shildi: ${channelId}`);
    });
});

bot.onText(/\/sremove\s+(.+)/, (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const channelId = match[1].trim();
    const db = readDB();
    db.studentChannels = (db.studentChannels || []).filter(c => c.channelId !== channelId);
    writeDB(db);
    bot.sendMessage(msg.chat.id, `🗑 Kanal o'chirildi: ${channelId}`);
});

bot.onText(/\/slist/, (msg) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const db = readDB();
    const list = (db.studentChannels || []).map(c => `📢 ${c.title || c.channelId} (${c.channelId})`).join('\n') || 'Kanal yo\'q.';
    bot.sendMessage(msg.chat.id, `📋 <b>Student bot kanallari:</b>\n\n${list}`, { parse_mode: 'HTML' });
});

// ─── Text handler (login flow) ────────────────────────────────────────────────

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    const ok = await checkSubs(userId);
    if (!ok) return sendSubWall(chatId);

    const state = loginStates.get(chatId);
    if (!state) return;

    if (state.step === 'phone') {
        const phone = text.replace(/\D/g, '');
        if (phone.length < 9) {
            return bot.sendMessage(chatId,
                '❌ Noto\'g\'ri format. Qayta kiriting:\n<i>Misol: 998901234567</i>',
                { parse_mode: 'HTML', reply_markup: cancelKeyboard() }
            );
        }
        state.phone = phone;
        state.step = 'password';
        loginStates.set(chatId, state);
        return bot.sendMessage(chatId, '🔑 Parolingizni kiriting:', { reply_markup: cancelKeyboard() });
    }

    if (state.step === 'password') {
        const { phone } = state;
        loginStates.delete(chatId);
        const loadMsg = await bot.sendMessage(chatId, '⌛ Tekshirilmoqda...');

        try {
            const res = await axios.post(`${BACKEND}/auth/login`, { phone, password: text });
            const { token, user } = res.data;

            if (user.role !== 'student') {
                bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
                return bot.sendMessage(chatId,
                    '❌ Bu bot faqat <b>o\'quvchilar</b> uchun mo\'ljallangan.\n\nO\'qituvchilar uchun alohida bot mavjud.',
                    { parse_mode: 'HTML', reply_markup: guestKeyboard() }
                );
            }

            saveSession(userId, {
                token,
                role: user.role,
                firstName: user.firstName,
                lastName: user.lastName,
                userId: user._id,
            });

            // Link telegram ID on server
            axios.post(`${BACKEND}/auth/link-telegram`,
                { telegramId: String(userId) },
                { headers: { Authorization: `Bearer ${token}` } }
            ).catch(() => {});

            bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
            bot.sendMessage(chatId,
                `✅ <b>Muvaffaqiyatli kirdingiz!</b>\n\n` +
                `👤 ${user.firstName} ${user.lastName || ''}\n\n` +
                `📋 <b>Mavjud buyruqlar:</b>\n` +
                `/profile — Mening profilim\n` +
                `/groups — Mening guruhlarim\n` +
                `/logout — Tizimdan chiqish`,
                { parse_mode: 'HTML', reply_markup: loggedInKeyboard() }
            );
        } catch (err) {
            bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
            const msg = err.response?.data?.message || 'Login yoki parol xato.';
            bot.sendMessage(chatId,
                `❌ ${msg}\n\nQayta kirish uchun /login yuboring.`,
                { reply_markup: guestKeyboard() }
            );
        }
    }
});

// ─── Callback handler ─────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const chatId  = query.message.chat.id;
    const userId  = query.from.id;
    const data    = query.data;
    const msgId   = query.message.message_id;

    // Subscription check
    if (data === 'check_sub') {
        const ok = await checkSubs(userId);
        if (ok) {
            bot.answerCallbackQuery(query.id, { text: '✅ Rahmat!' });
            bot.deleteMessage(chatId, msgId).catch(() => {});
            return sendHome(chatId, getSession(userId));
        }
        return bot.answerCallbackQuery(query.id, { text: '❌ Avval obuna bo\'ling!', show_alert: true });
    }

    // Sub wall guard for all other callbacks
    const ok = await checkSubs(userId);
    if (!ok) {
        bot.answerCallbackQuery(query.id, { text: '❌ Avval obuna bo\'ling!', show_alert: true });
        return sendSubWall(chatId);
    }

    bot.answerCallbackQuery(query.id);

    if (data === 'cancel') {
        loginStates.delete(chatId);
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return sendHome(chatId, getSession(userId));
    }

    if (data === 'login_start') {
        if (getSession(userId)) {
            return bot.sendMessage(chatId,
                '✅ Siz allaqachon tizimdasiz.',
                { reply_markup: loggedInKeyboard() }
            );
        }
        loginStates.set(chatId, { step: 'phone' });
        return bot.editMessageText(
            '🔐 <b>Tizimga kirish</b>\n\nTelefon raqamingizni kiriting:\n<i>Misol: 998901234567</i>',
            { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: cancelKeyboard() }
        );
    }

    if (data === 'logout') {
        removeSession(userId);
        loginStates.delete(chatId);
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        return bot.sendMessage(chatId,
            '🚪 Tizimdan chiqildi.\n\nQayta kirish uchun /login yuboring.',
            { reply_markup: guestKeyboard() }
        );
    }

    if (data === 'profile') {
        return showProfile(chatId, userId);
    }

    if (data === 'groups') {
        return showGroups(chatId, userId);
    }
});

// ─── Profile fetcher ──────────────────────────────────────────────────────────

async function showProfile(chatId, userId) {
    const session = getSession(userId);
    if (!session) {
        return bot.sendMessage(chatId,
            '❌ Tizimga kirilmagan. /login yuboring.',
            { reply_markup: guestKeyboard() }
        );
    }

    try {
        const res = await axios.get(`${BACKEND}/auth/profile`, {
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const user = res.data.user;

        const lines = [
            '👤 <b>Mening profilim</b>',
            '',
            `📛 Ism: <b>${user.firstName} ${user.lastName || ''}</b>`,
            `📞 Telefon: <code>+${user.phone}</code>`,
            `🎭 Rol: ${user.role === 'student' ? "O'quvchi" : user.role}`,
        ];
        if (user.gender) lines.push(`⚧ Jins: ${user.gender === 'male' ? '👨 Erkak' : '👩 Ayol'}`);
        if (user.age)    lines.push(`🎂 Yosh: ${user.age}`);

        bot.sendMessage(chatId, lines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: loggedInKeyboard(),
        });
    } catch (err) {
        if (err.response?.status === 401) {
            removeSession(userId);
            return bot.sendMessage(chatId,
                '⚠️ Sessiya muddati tugagan. Qayta kiring: /login',
                { reply_markup: guestKeyboard() }
            );
        }
        bot.sendMessage(chatId, '❌ Ma\'lumot olishda xatolik. Qaytadan urinib ko\'ring.');
    }
}

// ─── Groups fetcher ───────────────────────────────────────────────────────────

async function showGroups(chatId, userId) {
    const session = getSession(userId);
    if (!session) {
        return bot.sendMessage(chatId,
            '❌ Tizimga kirilmagan. /login yuboring.',
            { reply_markup: guestKeyboard() }
        );
    }

    try {
        const res = await axios.get(`${BACKEND}/enrollments`, {
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const enrollments = res.data.enrollments || [];

        if (!enrollments.length) {
            return bot.sendMessage(chatId,
                '📚 Siz hech qaysi guruhga biriktirilmagansiz.',
                { reply_markup: loggedInKeyboard() }
            );
        }

        const lines = ['📚 <b>Mening guruhlarim:</b>', ''];

        enrollments.forEach((enr, i) => {
            const g = enr.group;
            lines.push(`${i + 1}. <b>${g?.name || 'Guruh'}</b>`);
            if (g?.price)   lines.push(`   💰 Narx: ${g.price.toLocaleString()} so'm`);
            if (g?.teacher) lines.push(`   👨‍🏫 O'qituvchi: ${g.teacher.firstName || ''} ${g.teacher.lastName || ''}`);
            const status = enr.status === 'active' ? '✅ Faol' : enr.status === 'completed' ? '🎓 Tugatilgan' : enr.status || '—';
            lines.push(`   📌 Holat: ${status}`);
            lines.push('');
        });

        bot.sendMessage(chatId, lines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: loggedInKeyboard(),
        });
    } catch (err) {
        if (err.response?.status === 401) {
            removeSession(userId);
            return bot.sendMessage(chatId,
                '⚠️ Sessiya muddati tugagan. Qayta kiring: /login',
                { reply_markup: guestKeyboard() }
            );
        }
        bot.sendMessage(chatId, '❌ Ma\'lumot olishda xatolik. Qaytadan urinib ko\'ring.');
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

console.log('🎓 Bayyina Student Bot ishga tushdi.');
