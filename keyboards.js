/**
 * keyboards.js — Telegram inline keyboards for Bayyina bot.
 */

function mainMenuKeyboard(role = null, isAdmin = false) {
    const kb = [];

    if (role) {
        const panelUrls = {
            student: 'https://student.bayyina.org.uz',
            teacher: 'https://teacher.bayyina.org.uz',
        };
        kb.push([{ text: '🌐 Shaxsiy kabinet', web_app: { url: panelUrls[role] || panelUrls.student } }]);
        kb.push([{ text: '🚪 Chiqish', callback_data: 'crm_logout' }]);
    } else {
        kb.push([{ text: '🔑 Tizimga kirish', callback_data: 'crm_login_start' }]);
    }

    return { inline_keyboard: kb };
}

function cancelKeyboard() {
    return {
        inline_keyboard: [[{ text: '❌ Bekor qilish', callback_data: 'flow_cancel' }]],
    };
}

module.exports = { mainMenuKeyboard, cancelKeyboard };
