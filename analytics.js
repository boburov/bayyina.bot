/**
 * analytics.js — Local funnel analytics stored in db.json.
 *
 * Funnel steps:
 *   started_bot → selected_course → started_form → completed_form
 *
 * Also tracks: cancelled (at which step), source distribution.
 */

const { readDB, writeDB } = require('./db');

// ─── Track event ──────────────────────────────────────────────────────────────

/**
 * Record a funnel event for a user.
 * @param {string} telegramId
 * @param {'started_bot'|'selected_course'|'started_form'|'completed_form'|'cancelled'} event
 * @param {object} [meta] - e.g. { course, source, cancelledAt }
 */
function track(telegramId, event, meta = {}) {
    const db = readDB();
    if (!db.analytics) db.analytics = { events: [], funnel: {} };

    db.analytics.events.push({
        telegramId: String(telegramId),
        event,
        meta,
        ts: Date.now(),
    });

    // Funnel counters
    if (!db.analytics.funnel[event]) db.analytics.funnel[event] = 0;
    db.analytics.funnel[event]++;

    // Keep only last 10 000 events to avoid unbounded growth
    if (db.analytics.events.length > 10_000) {
        db.analytics.events = db.analytics.events.slice(-10_000);
    }

    writeDB(db);
}

// ─── Get summary ──────────────────────────────────────────────────────────────

function getSummary() {
    const db = readDB();
    const { events = [], funnel = {} } = db.analytics || {};

    const started      = funnel.started_bot      || 0;
    const selectedCourse = funnel.selected_course || 0;
    const startedForm  = funnel.started_form      || 0;
    const completed    = funnel.completed_form    || 0;
    const cancelled    = funnel.cancelled         || 0;

    // Conversion rate: completed / started
    const convRate = started > 0 ? ((completed / started) * 100).toFixed(1) : '0.0';

    // Drop-off per step
    const dropCourseSelect = started - selectedCourse;
    const dropFormStart    = selectedCourse - startedForm;
    const dropFormComplete = startedForm - completed;

    // Source distribution from last 500 events
    const recent = events.slice(-500);
    const sourceCounts = {};
    for (const e of recent) {
        if (e.meta?.source) {
            sourceCounts[e.meta.source] = (sourceCounts[e.meta.source] || 0) + 1;
        }
    }

    // Course interest distribution
    const courseCounts = {};
    for (const e of recent) {
        if (e.event === 'selected_course' && e.meta?.course) {
            courseCounts[e.meta.course] = (courseCounts[e.meta.course] || 0) + 1;
        }
    }

    return {
        funnel: { started, selectedCourse, startedForm, completed, cancelled },
        conversion: { rate: convRate + '%', count: completed, total: started },
        dropOff: {
            afterStart:       dropCourseSelect,
            afterCourse:      dropFormStart,
            duringForm:       dropFormComplete,
        },
        sources: sourceCounts,
        courseInterest: courseCounts,
    };
}

// ─── Format for Telegram ──────────────────────────────────────────────────────

function formatSummary(s) {
    const lines = [
        '📊 <b>Bot Analitikasi</b>',
        '',
        '🔽 <b>Voronka (Funnel):</b>',
        `  🤖 Bot boshlandi:     ${s.funnel.started}`,
        `  📚 Kurs tanlandi:     ${s.funnel.selectedCourse}`,
        `  ✍️  Forma boshlandi:   ${s.funnel.startedForm}`,
        `  ✅ Forma yakunlandi:  ${s.funnel.completed}`,
        `  ❌ Bekor qilindi:     ${s.funnel.cancelled}`,
        '',
        `📈 <b>Konversiya:</b> ${s.conversion.rate} (${s.conversion.count}/${s.conversion.total})`,
        '',
        '📉 <b>Tushish nuqtalari:</b>',
        `  Start → Kurs tanlamasdan: ${s.dropOff.afterStart}`,
        `  Kurs → Forma boshlamamasdan: ${s.dropOff.afterCourse}`,
        `  Forma → Yakunlamamasdan: ${s.dropOff.duringForm}`,
    ];

    // Sources
    if (Object.keys(s.sources).length > 0) {
        lines.push('', '📢 <b>Manbalar:</b>');
        for (const [src, cnt] of Object.entries(s.sources).sort(([, a], [, b]) => b - a)) {
            lines.push(`  • ${src}: ${cnt}`);
        }
    }

    // Course interest
    if (Object.keys(s.courseInterest).length > 0) {
        lines.push('', '🎯 <b>Kurs qiziqishi:</b>');
        for (const [c, cnt] of Object.entries(s.courseInterest).sort(([, a], [, b]) => b - a)) {
            lines.push(`  • ${c}: ${cnt}`);
        }
    }

    return lines.join('\n');
}

module.exports = { track, getSummary, formatSummary };
