const fs = require('fs');

/**
 * keyboards.js — All Telegram inline keyboard builders for the Bayyina bot.
 */

function getCourses() {
    try {
        const data = fs.readFileSync('./data/courses.json', 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

// ─── Main menu ──────────────────────────────────────────────────────────────

function mainMenuKeyboard(role = null, isAdmin = false) {
    const kb = [
        [{ text: '📚 Kurs tanlash va yozilish', callback_data: 'flow_courses' }]
    ];

    if (role) {
        const panelUrls = {
            admin:   process.env.ADMIN_APP_URL || 'https://admin.bayyina.uz',
            teacher: process.env.TEACHER_APP_URL || 'https://teacher.bayyina.uz',
            student: process.env.STUDENT_APP_URL || 'https://student.bayyina.uz'
        };
        kb.push([{ text: '🌐 Shaxsiy kabinet', web_app: { url: panelUrls[role] || panelUrls.student } }]);
    } else {
        kb.push([{ text: '🔑 CRM ga kirish', callback_data: 'crm_login_start' }]);
    }

    if (isAdmin) {
        kb.push([{ text: '🛠 Kurslarni boshqarish', callback_data: 'admin_courses_mgmt' }]);
    }

    if (role) {
        kb.push([{ text: '🚪 Chiqish', callback_data: 'crm_logout' }]);
    }

    return { inline_keyboard: kb };
}

// ─── Course selection ────────────────────────────────────────────────────────

function coursesKeyboard() {
    const COURSES = getCourses();
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

// ─── Admin Course Management ─────────────────────────────────────────────────

function adminCoursesKeyboard() {
    const COURSES = getCourses();
    const rows = COURSES.map(c => [
        { text: `🗑 ${c.label}`, callback_data: `admin_course_del_${c.id}` }
    ]);
    rows.push([{ text: '➕ Kurs qo\'shish', callback_data: 'admin_course_add' }]);
    rows.push([{ text: '◀️ Orqaga', callback_data: 'admin_back' }]);
    return { inline_keyboard: rows };
}

// ─── Others ──────────────────────────────────────────────────────────────────

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

function cancelKeyboard() {
    return {
        inline_keyboard: [[{ text: '❌ Bekor qilish', callback_data: 'flow_cancel' }]],
    };
}

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
    getCourses,
    mainMenuKeyboard,
    coursesKeyboard,
    adminCoursesKeyboard,
    genderKeyboard,
    cancelKeyboard,
    leadActionsKeyboard,
    paginationKeyboard,
};
