/**
 * flow.js — Lead generation conversation state machine.
 */

const fs = require('fs');
const { createLead } = require('./leads');
const { track } = require('./analytics');
const {
    getCourses,
    coursesKeyboard,
    genderKeyboard,
    cancelKeyboard,
} = require('./keyboards');

// ─── In-memory state store ────────────────────────────────────────────────────
const sessions = new Map();

const STEP_PROMPTS = {
    name:       '👤 <b>Qadam 1/4 — Ismingizni kiriting:</b>',
    phone:      '📱 <b>Qadam 2/4 — Telefon raqamingiz:</b>\n\n<i>Misol: +998901234567</i>',
    age:        '🎂 <b>Qadam 3/4 — Yoshingiz (raqamda):</b>',
    profession: '💼 <b>Qadam 4/4 — Kasbingiz yoki siz haqingizda:</b>\n\n<i>Misol: Talaba, Dasturchiman, Ingliz tili o\'qituvchisiman</i>',
};

function getAdminIds() {
    return process.env.ADMIN_IDS
        ? process.env.ADMIN_IDS.split(',').map(Number).filter(Boolean)
        : [];
}

// ─── Local Lead Backup ────────────────────────────────────────────────────────

function backupLeadLocal(lead) {
    try {
        const filePath = './data/leads.json';
        let leads = [];
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            leads = JSON.parse(data);
        }
        leads.push({
            ...lead,
            localCreatedAt: new Date().toISOString()
        });
        fs.writeFileSync(filePath, JSON.stringify(leads, null, 2));
    } catch (e) {
        console.error('Local backup error:', e);
    }
}

// ─── Start flow ───────────────────────────────────────────────────────────────

function startFlow(bot, chatId, telegramId, uniqueLink = null) {
    sessions.set(String(telegramId), {
        step: 'course',
        data: { uniqueLink },
    });

    track(telegramId, 'started_bot');

    bot.sendMessage(chatId,
        '🎓 <b>Bayyina ta\'lim markaziga xush kelibsiz!</b>\n\n' +
        'Qaysi kursga qiziqasiz? Pastdagi tugmalardan birini tanlang:',
        { parse_mode: 'HTML', reply_markup: coursesKeyboard() }
    );
}

function cancelFlow(bot, chatId, telegramId) {
    sessions.delete(String(telegramId));
    bot.sendMessage(chatId,
        '✋ Bekor qilindi.\n\nQayta boshlash uchun /start yuboring.',
        { parse_mode: 'HTML' }
    );
}

function handleCourseSelect(bot, query, telegramId, courseId) {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    const COURSES = getCourses();
    const course = COURSES.find(c => c.id === courseId);
    if (!course) {
        bot.answerCallbackQuery(query.id, { text: '❌ Noto\'g\'ri tanlov', show_alert: true });
        return;
    }

    let session = sessions.get(String(telegramId));
    if (!session) session = { step: 'course', data: {} };

    session.data.course   = course.id;
    session.data.interest = course.label.replace(/^[^\s]+\s/, ''); 
    session.step = 'name';
    sessions.set(String(telegramId), session);

    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
        `✅ Kurs tanlandi: <b>${course.label}</b>\n\n${STEP_PROMPTS.name}`,
        {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   'HTML',
            reply_markup: cancelKeyboard(),
        }
    );
}

function handleGenderSelect(bot, query, telegramId, gender) {
    const chatId = query.message.chat.id;
    const session = sessions.get(String(telegramId));
    if (!session || session.step !== 'gender') return false;

    session.data.gender = gender;
    session.step = 'profession';
    sessions.set(String(telegramId), session);

    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
        STEP_PROMPTS.profession,
        {
            chat_id:      chatId,
            message_id:   query.message.message_id,
            parse_mode:   'HTML',
            reply_markup: cancelKeyboard(),
        }
    );
    return true;
}

async function handleText(bot, msg) {
    const telegramId = String(msg.from.id);
    const session    = sessions.get(telegramId);
    if (!session || session.step === 'course' || session.step === 'gender') return false;

    const chatId = msg.chat.id;
    const text   = (msg.text || '').trim();

    if (!text || text.startsWith('/')) {
        sessions.delete(telegramId);
        return false;
    }

    const step = session.step;

    if (step === 'phone') {
        const digits = text.replace(/\D/g, '');
        if (digits.length < 9) {
            bot.sendMessage(chatId, '❌ Telefon raqam noto\'g\'ri.\n\n' + STEP_PROMPTS.phone, { parse_mode: 'HTML', reply_markup: cancelKeyboard() });
            return true;
        }
        session.data.phone = digits;
    } else if (step === 'age') {
        const n = Number(text);
        if (isNaN(n) || n < 5 || n > 100) {
            bot.sendMessage(chatId, '❌ Yosh 5–100 orasida bo\'lishi kerak.\n\n' + STEP_PROMPTS.age, { parse_mode: 'HTML', reply_markup: cancelKeyboard() });
            return true;
        }
        session.data.age = n;
    } else {
        session.data[step] = text;
    }

    const nextSteps = { name: 'phone', phone: 'age', age: 'gender', profession: 'done' };
    session.step = nextSteps[step];

    if (session.step === 'gender') {
        bot.sendMessage(chatId, '⚧  <b>Jins:</b>', { parse_mode: 'HTML', reply_markup: genderKeyboard() });
    } else if (session.step === 'done') {
        await submitLead(bot, chatId, telegramId, session.data);
    } else {
        bot.sendMessage(chatId, STEP_PROMPTS[session.step], { parse_mode: 'HTML', reply_markup: cancelKeyboard() });
    }
    return true;
}

async function submitLead(bot, chatId, telegramId, data) {
    sessions.delete(String(telegramId));

    const payload = {
        firstName:  data.firstName || data.name,
        phone:      Number(data.phone),
        telegramId: String(telegramId),
        gender:     data.gender,
        age:        Number(data.age),
        profession: data.profession,
        source:     data.source || 'telegram',
        interest:   data.interest,
        uniqueLink: data.uniqueLink,
    };

    // 1. Local backup
    backupLeadLocal(payload);

    // 2. Submit to API
    const result = await createLead(payload, telegramId);

    if (result.success) {
        await bot.sendMessage(chatId,
            '✅ <b>Murojaatingiz qabul qilindi!</b>\n\n' +
            '📞 Adminimiz 24 soat ichida siz bilan bog\'lanadi.\n\n' +
            'Savollar uchun: /help',
            { parse_mode: 'HTML' }
        );
        notifyAdmins(bot, { ...payload, ...result.lead });
    } else if (result.error === 'duplicate') {
        await bot.sendMessage(chatId,
            '✅ Siz allaqachon ro\'yxatdan o\'tgansiz!\n\n' +
            'Adminimiz tez orada siz bilan bog\'lanadi.',
            { parse_mode: 'HTML' }
        );
    } else {
        await bot.sendMessage(chatId,
            '❌ Xatolik yuz berdi. Iltimos keyinroq urinib ko\'ring yoki /start bilan qayta boshlang.',
            { parse_mode: 'HTML' }
        );
    }
}

function notifyAdmins(bot, lead) {
    const admins = getAdminIds();
    const date = new Date().toLocaleString('uz-UZ');
    const text = [
        '🔔 <b>Yangi murojaat!</b>',
        '',
        `👤 Ism: <b>${lead.firstName || '—'}</b>`,
        `📞 Telefon: +${lead.phone || '—'}`,
        `✈️ Telegram: <code>${lead.telegramId || '—'}</code>`,
        `⚧  Jins: ${lead.gender === 'male' ? '👨 Erkak' : lead.gender === 'female' ? '👩 Ayol' : '—'}`,
        `🎂 Yosh: ${lead.age || '—'}`,
        `💼 Kasb: ${lead.profession || '—'}`,
        `📢 Manba: ${lead.source || '—'}`,
        `📚 Qiziqish: ${lead.interest || '—'}`,
        `🕐 ${date}`,
    ].join('\n');

    for (const adminId of admins) {
        bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
    }
}

function hasActiveSession(telegramId) {
    return sessions.has(String(telegramId));
}

module.exports = {
    startFlow,
    cancelFlow,
    handleCourseSelect,
    handleGenderSelect,
    handleText,
    notifyAdmins,
    hasActiveSession,
};
