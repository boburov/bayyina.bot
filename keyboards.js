/**
 * keyboards.js — All Telegram inline keyboard builders for the Bayyina bot.
 */

// ─── Main menu ──────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📚 Kurs tanlash va yozilish', callback_data: 'flow_courses' }],
            [{ text: '🚀 Shaxsiy kabinetni ochish', web_app: { url: process.env.STUDENT_APP_URL || 'https://student.bayyina.uz' } }],
            [{ text: '🔑 Hisobga kirish', callback_data: 'login_start' }],
        ],
    };
}

// ─── Course selection ────────────────────────────────────────────────────────

const COURSES = [
    { id: 'english_morning',  label: '🌅 Ingliz tili (Ertalab)' },
    { id: 'english_evening',  label: '🌆 Ingliz tili (Kechqurun)' },
    { id: 'ielts',            label: '📊 IELTS tayyorlov' },
    { id: 'it_basics',        label: '💻 IT asoslari' },
    { id: 'russian',          label: '🇷🇺 Rus tili' },
    { id: 'math',             label: '📐 Matematika' },
    { id: 'other',            label: '📋 Boshqa kurs' },
];

function coursesKeyboard() {
    const rows = [];
    for (let i = 0; i < COURSES.length; i += 2) {
        const row = [{ text: COURSES[i].label, callback_data: `flow_course_${COURSES[i].id}` }];
        if (COURSES[i + 1]) {
            row.push({ text: COURSES[i + 1].label, callback_data: `flow_course_${COURSES[i + 1].id}` });
        }
        rows.push(row);
    }
    rows.push([{ text: '❌ Bekor qilish', callback_data: 'flow_cancel' }]);
    return { inline_keyboard: rows };
}

// ─── Gender ──────────────────────────────────────────────────────────────────

function genderKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '👨 Erkak', callback_data: 'flow_gender_male' },
                { text: '👩 Ayol',  callback_data: 'flow_gender_female' },
            ],
            [{ text: '❌ Bekor qilish', callback_data: 'flow_cancel' }],
        ],
    };
}

// ─── Source ──────────────────────────────────────────────────────────────────

function sourceKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '📸 Instagram',    callback_data: 'flow_source_instagram' },
                { text: '✈️ Telegram',     callback_data: 'flow_source_telegram' },
            ],
            [
                { text: '👥 Do\'st orqali', callback_data: 'flow_source_referral' },
                { text: '🌍 Boshqa',        callback_data: 'flow_source_other' },
            ],
            [{ text: '❌ Bekor qilish', callback_data: 'flow_cancel' }],
        ],
    };
}

// ─── Cancel-only ─────────────────────────────────────────────────────────────

function cancelKeyboard() {
    return {
        inline_keyboard: [[{ text: '❌ Bekor qilish', callback_data: 'flow_cancel' }]],
    };
}

// ─── Admin lead actions ───────────────────────────────────────────────────────

function leadActionsKeyboard(leadId) {
    return {
        inline_keyboard: [
            [
                { text: '📞 Bog\'lashildi', callback_data: `lead_status_${leadId}_contacted` },
                { text: '📅 Rejalashtir',  callback_data: `lead_status_${leadId}_scheduled` },
            ],
            [
                { text: '❌ Rad etish',    callback_data: `lead_status_${leadId}_rejected` },
                { text: '🎓 Qabul qilish', callback_data: `lead_convert_${leadId}` },
            ],
            [{ text: '◀️ Ro\'yxatga qaytish', callback_data: 'leads_list_1' }],
        ],
    };
}

function paginationKeyboard(page, totalPages) {
    const row = [];
    if (page > 1)          row.push({ text: '◀️ Oldingi', callback_data: `leads_list_${page - 1}` });
    if (page < totalPages) row.push({ text: 'Keyingi ▶️', callback_data: `leads_list_${page + 1}` });
    return row.length ? { inline_keyboard: [row] } : null;
}

module.exports = {
    COURSES,
    mainMenuKeyboard,
    coursesKeyboard,
    genderKeyboard,
    sourceKeyboard,
    cancelKeyboard,
    leadActionsKeyboard,
    paginationKeyboard,
};
