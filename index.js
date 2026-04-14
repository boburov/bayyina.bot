require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { readDB, writeDB, setToken } = require('./db');
const { registerLeadsHandlers, handleLeadsCallback, autoCreateLead } = require('./leads');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMINS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(Number)
    : [];
const BACKEND_URL = process.env.BACKEND_URL || 'http://156.67.29.62:4000/api';

// ── Utility ────────────────────────────────────────────────────────────────────

function extractUsername(input) {
    if (input.includes('t.me/')) {
        return '@' + input.split('t.me/')[1].split('/')[0];
    }
    if (input.startsWith('@')) return input;
    return '@' + input;
}

// ── Subscription helpers ───────────────────────────────────────────────────────

async function checkAllSubscriptions(userId) {
    const db = readDB();
    if (db.channels.length === 0) return true;

    for (let ch of db.channels) {
        try {
            const member = await bot.getChatMember(ch.channelId, userId);
            if (!['member', 'administrator', 'creator'].includes(member.status)) {
                return false;
            }
        } catch (err) {
            return false;
        }
    }
    return true;
}

// ── Help / menu ────────────────────────────────────────────────────────────────

bot.onText(/\/help|\/commands|\/menu/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMINS.includes(userId)) {
        return bot.sendMessage(chatId,
            "👤 Oddiy foydalanuvchi buyruqlari:\n\n" +
            "/start - Botni ishga tushirish\n" +
            "Hisobga kirish uchun: +99890xxxxxxx parol"
        );
    }

    const adminHelp = `
🛠 <b>Admin Buyruqlari</b>

📌 Asosiy buyruqlar:
• /start - Botni boshlash
• /help yoki /menu - Ushbu menyuni ko'rish

📢 Kanal boshqarish:
• /add https://t.me/kanalusername - Kanal qo'shish
• /remove @kanalusername - Kanalni o'chirish
• /list - Barcha kanallarni ko'rish

👥 Lead boshqarish (login kerak):
• /leads - Leadlar ro'yxati
• /leads 2 - 2-sahifani ko'rish

🔍 Misol:
 /add https://t.me/maktabkanal
 /remove @maktabkanal
    `.trim();

    bot.sendMessage(chatId, adminHelp, { parse_mode: 'HTML' });
});

// ── /start (with optional deep-link for referral tracking) ────────────────────

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const deepLink = match[1]?.trim() || null;

    // 1. Silently create lead for first-time users
    await autoCreateLead(msg);

    // 2. Track referral / unique link if present
    if (deepLink) {
        axios.get(`${BACKEND_URL}/leads/track/${encodeURIComponent(deepLink)}`)
            .catch(() => { }); // tracking failures must never disrupt UX
    }

    // 3. Subscription gate
    const isSubscribed = await checkAllSubscriptions(userId);

    if (!isSubscribed) {
        const db = readDB();
        const buttons = db.channels.map(ch => [{
            text: `📢 ${ch.channelId}`,
            url: `https://t.me/${ch.channelId.replace('@', '')}`
        }]);
        buttons.push([{ text: "✅ Obunani tekshirish", callback_data: "check_sub" }]);

        return bot.sendMessage(chatId,
            "👋 Xush kelibsiz!\n\n" +
            "Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling:",
            { reply_markup: { inline_keyboard: buttons } }
        );
    }

    // 4. Subscribed → main menu
    const keyboard = [
        [{ text: "🚀 Mini Ilovani Ochish", web_app: { url: "https://student.bayyina.uz" } }],
        [{ text: "🔑 Hisobga Kirish", callback_data: "login_start" }]
    ];

    bot.sendMessage(chatId, "✅ Obuna tasdiqlandi!\nBotdan to'liq foydalanishingiz mumkin.", {
        reply_markup: { inline_keyboard: keyboard }
    });
});

// ── Callback queries ───────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;

    // Delegate leads callbacks first
    const handledByLeads = await handleLeadsCallback(bot, query);
    if (handledByLeads) return;

    if (data === 'check_sub') {
        const isSub = await checkAllSubscriptions(userId);
        if (isSub) {
            bot.sendMessage(chatId, "✅ Obuna tasdiqlandi! Endi foydalanishingiz mumkin.");
        } else {
            bot.answerCallbackQuery(query.id, {
                text: "❌ Hali barcha kanallarga obuna bo'lmadingiz!",
                show_alert: true,
            });
        }
        return;
    }

    if (data === 'login_start') {
        bot.sendMessage(chatId,
            "📱 Hisobga kirish uchun telefon raqam va parolingizni yuboring:\n\n" +
            "Format:\n`+998901234567 secret123`",
            { parse_mode: 'Markdown' }
        );
    }
});

// ── Login (text message) ───────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Silently create lead for first-time text senders
    autoCreateLead(msg).catch(() => { });

    // Detect phone + password format
    const match = text.match(/^(\+?998\d{9})\s+(.+)$/);
    if (!match) return;

    const phone = match[1].replace('+', '');
    const password = match[2];

    try {
        const response = await axios.post(`${BACKEND_URL}/auth/login`, {
            phone: Number(phone),
            password,
            telegramId: msg.from.id.toString(),
        });

        const { token, user, message } = response.data;

        if (response.data.code === "loginSuccess") {
            // Persist JWT so protected API calls (leads, etc.) can use it
            setToken(String(msg.from.id), token);

            bot.sendMessage(chatId,
                `✅ ${message}\n\n` +
                `👤 ${user.firstName} ${user.lastName}\n` +
                `🎓 Rol: ${user.role}\n` +
                `🔑 Token muvaffaqiyatli saqlandi!\n\n` +
                `📋 Leadlarni ko'rish uchun /leads buyrug'ini yuboring.`,
                { parse_mode: 'HTML' }
            );
        } else {
            bot.sendMessage(chatId, "❌ Login muvaffaqiyatsiz: " + message);
        }
    } catch (err) {
        console.error(err.response?.data || err.message);
        bot.sendMessage(chatId, err.message);
    }
});

// ── Admin: channel management ──────────────────────────────────────────────────

bot.onText(/^\/add(?:\s+(.+))?$/, async (msg, match) => {
    if (!ADMINS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Siz admin emassiz!");

    const url = match[1];
    if (!url) return bot.sendMessage(msg.chat.id, "❌ /add https://t.me/kanal");

    try {
        const channelId = extractUsername(url);

        const chat = await bot.getChat(channelId);
        await bot.sendMessage(msg.chat.id, `✅ Kanal topildi: ${chat.title || channelId}\nBotni admin qilganingizga ishonch hosil qiling!`);

        const db = readDB();
        if (db.channels.some(c => c.channelId === channelId)) {
            return bot.sendMessage(msg.chat.id, "⚠️ Bu kanal allaqachon qo'shilgan!");
        }

        db.channels.push({ channelId });
        writeDB(db);

        bot.sendMessage(msg.chat.id, `✅ Kanal muvaffaqiyatli qo'shildi: ${channelId}`);
    } catch (e) {
        bot.sendMessage(msg.chat.id, "❌ Kanal topilmadi yoki bot admin emas!");
    }
});

bot.onText(/^\/remove\s+(.+)$/, async (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!ADMINS.includes(userId)) {
        return bot.sendMessage(chatId, "❌ Siz admin emassiz!");
    }

    const channelId = extractUsername(match[1].trim());
    const db = readDB();
    const exists = db.channels.find(c => c.channelId === channelId);

    if (!exists) {
        return bot.sendMessage(chatId, `⚠️ Bu kanal topilmadi: ${channelId}`);
    }

    db.channels = db.channels.filter(c => c.channelId !== channelId);
    writeDB(db);

    bot.sendMessage(chatId, `🗑 Kanal muvaffaqiyatli o'chirildi:\n<b>${channelId}</b>`, {
        parse_mode: 'HTML'
    });
});

bot.onText(/\/list/, (msg) => {
    if (!ADMINS.includes(msg.from.id)) return;
    const db = readDB();
    if (db.channels.length === 0) return bot.sendMessage(msg.chat.id, "📭 Hozircha kanal yo'q");

    const text = db.channels.map(c => `• ${c.channelId}`).join('\n');
    bot.sendMessage(msg.chat.id, `📢 Qo'shilgan kanallar:\n\n${text}`);
});

// ── Register leads /leads command ──────────────────────────────────────────────
registerLeadsHandlers(bot);
