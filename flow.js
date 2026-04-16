/**
 * flow.js — Lead generation conversation state machine.
 *
 * Conversation steps:
 *   COURSE   → user selects which course they're interested in
 *   NAME     → first name
 *   PHONE    → phone number
 *   AGE      → age
 *   GENDER   → gender (inline button)
 *   PROFESSION → job/profession (text)
 *   DONE     → submit to backend
 *
 * Step indicator shown at every text-input step.
 * Cancel button available at every step.
 */

const { createLead, fmtLead } = require('./leads');
const { track }               = require('./analytics');
const {
    coursesKeyboard,
    genderKeyboard,
    cancelKeyboard,
    COURSES,
} = require('./keyboards');

// ─── In-memory state store ────────────────────────────────────────────────────
// Map<telegramId, { step, data: { course, firstName, phone, age, gender, profession, uniqueLink } }>
const sessions = new Map();

const TEXT_STEPS = ['name', 'phone', 'age', 'profession'];
const TOTAL_TEXT_STEPS = 4; // name, phone, age, profession

const STEP_INDEX = { name: 1, phone: 2, age: 3, profession: 4 };

const STEP_PROMPTS = {
    name:       '👤 <b>Qadam 1/4 — Ismingizni kiriting:</b>',
    phone:      '📱 <b>Qadam 2/4 — Telefon raqamingiz:</b>\n\n<i>Misol: +998901234567</i>',
    age:        '🎂 <b>Qadam 3/4 — Yoshingiz (raqamda):</b>',
    profession: '💼 <b>Qadam 4/4 — Kasbingiz yoki siz haqingizda:</b>\n\n<i>Misol: Talaba, Dasturchiman, Ingliz tili o\'qituvchisiman</i>',
};

// ─── Admin IDs from env ───────────────────────────────────────────────────────

function getAdminIds() {
    return process.env.ADMIN_IDS
        ? process.env.ADMIN_IDS.split(',').map(Number).filter(Boolean)
        : [];
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

// ─── Cancel flow ─────────────────────────────────────────────────────────────

function cancelFlow(bot, chatId, telegramId) {
    const session = sessions.get(String(telegramId));
    const step = session?.step || 'unknown';
    sessions.delete(String(telegramId));

    track(telegramId, 'cancelled', { cancelledAt: step });

    bot.sendMessage(chatId,
        '✋ Bekor qilindi.\n\n' +
        'Qayta boshlash uchun /start yuboring.',
        { parse_mode: 'HTML' }
    );
}

// ─── Handle course selection ──────────────────────────────────────────────────

function handleCourseSelect(bot, query, telegramId, courseId) {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    const course = COURSES.find(c => c.id === courseId);
    if (!course) {
        bot.answerCallbackQuery(query.id, { text: '❌ Noto\'g\'ri tanlov', show_alert: true });
        return;
    }

    let session = sessions.get(String(telegramId));
    if (!session) {
        session = { step: 'course', data: {} };
    }

    session.data.course   = course.id;
    session.data.interest = course.label.replace(/^[^\s]+\s/, ''); // strip emoji
    session.step = 'name';
    sessions.set(String(telegramId), session);

    track(telegramId, 'selected_course', { course: course.id });
    track(telegramId, 'started_form');

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

// ─── Handle gender selection ──────────────────────────────────────────────────

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

// ─── Handle text input ────────────────────────────────────────────────────────

/**
 * Route incoming text to the current wizard step.
 * @returns {boolean} true if handled by wizard
 */
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

    // Validation
    if (step === 'phone') {
        const digits = text.replace(/\D/g, '');
        if (digits.length < 7) {
            bot.sendMessage(chatId,
                '❌ Telefon raqam noto\'g\'ri.\n\n' + STEP_PROMPTS.phone,
                { parse_mode: 'HTML', reply_markup: cancelKeyboard() }
            );
            return true;
        }
        session.data.phone = digits;
    } else if (step === 'age') {
        const n = Number(text);
        if (isNaN(n) || n < 5 || n > 100) {
            bot.sendMessage(chatId,
                '❌ Yosh 5–100 orasida bo\'lishi kerak.\n\n' + STEP_PROMPTS.age,
                { parse_mode: 'HTML', reply_markup: cancelKeyboard() }
            );
            return true;
        }
        session.data.age = n;
    } else {
        session.data[step] = text;
    }

    // Advance
    const nextSteps = { name: 'phone', phone: 'age', age: 'gender', profession: 'done' };
    session.step = nextSteps[step];

    if (session.step === 'gender') {
        bot.sendMessage(chatId,
            '⚧  <b>Jins:</b>',
            { parse_mode: 'HTML', reply_markup: genderKeyboard() }
        );
    } else if (session.step === 'done') {
        await submitLead(bot, chatId, telegramId, session.data);
    } else {
        bot.sendMessage(chatId,
            STEP_PROMPTS[session.step],
            { parse_mode: 'HTML', reply_markup: cancelKeyboard() }
        );
    }
    return true;
}

// ─── Submit lead ──────────────────────────────────────────────────────────────

async function submitLead(bot, chatId, telegramId, data) {
    sessions.delete(String(telegramId));

    const payload = {
        firstName:  data.firstName || data.name,
        phone:      data.phone,
        telegramId,
        gender:     data.gender,
        age:        data.age,
        profession: data.profession,
        source:     data.source || 'telegram',
        interest:   data.interest,
        uniqueLink: data.uniqueLink,
    };

    const result = await createLead(payload, telegramId);

    if (result.success) {
        track(telegramId, 'completed_form', { source: payload.source, course: data.course });

        await bot.sendMessage(chatId,
            '✅ <b>Murojaatingiz qabul qilindi!</b>\n\n' +
            '📞 Adminimiz 24 soat ichida siz bilan bog\'lanadi.\n\n' +
            'Savollar uchun: /help',
            { parse_mode: 'HTML' }
        );

        // Notify admins
        notifyAdmins(bot, { ...payload, ...result.lead });

        // Schedule 24h reminder if lead is not contacted
        scheduleContactReminder(bot, result.lead?._id || 'unknown', payload.firstName, telegramId);

    } else if (result.error === 'no_token' || result.error === 'unauthorized') {
        await bot.sendMessage(chatId,
            '⚠️ Tizimda texnik muammo yuz berdi.\n\n' +
            'Iltimos keyinroq qayta urinib ko\'ring yoki /start bilan qayta boshlang.',
            { parse_mode: 'HTML' }
        );
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

// ─── Admin notification ───────────────────────────────────────────────────────

function notifyAdmins(bot, lead) {
    const admins = getAdminIds();
    const date = new Date().toLocaleString('uz-UZ');

    const text = [
        '🔔 <b>Yangi murojaat!</b>',
        '',
        `👤 Ism: <b>${lead.firstName || '—'}</b>`,
        `📞 Telefon: ${lead.phone || '—'}`,
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

// ─── 24h contact reminder ─────────────────────────────────────────────────────

const reminderTimers = new Map(); // leadId → timer

function scheduleContactReminder(bot, leadId, firstName, leaderTelegramId) {
    const admins = getAdminIds();
    if (!admins.length || leadId === 'unknown') return;

    const DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

    // Clear any existing reminder for this lead
    if (reminderTimers.has(leadId)) clearTimeout(reminderTimers.get(leadId));

    const timer = setTimeout(() => {
        reminderTimers.delete(leadId);
        for (const adminId of admins) {
            bot.sendMessage(adminId,
                `⏰ <b>Eslatma!</b>\n\n` +
                `<b>${firstName}</b> bilan 24 soatdan beri bog'lanilmadi!\n\n` +
                `Lead ID: <code>${leadId}</code>\n` +
                `Iltimos, tez orada bog'laning.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    }, DELAY_MS);

    reminderTimers.set(leadId, timer);
}

/** Cancel a reminder (e.g. when lead is marked contacted). */
function cancelReminder(leadId) {
    if (reminderTimers.has(leadId)) {
        clearTimeout(reminderTimers.get(leadId));
        reminderTimers.delete(leadId);
    }
}

// ─── Active session check ─────────────────────────────────────────────────────

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
    cancelReminder,
    hasActiveSession,
};
