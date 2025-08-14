/*** DB על localStorage ***/
const DB_KEY = 'almog_asaf_barbershop_db_v1';
function loadDB() {
    try {
        return JSON.parse(localStorage.getItem(DB_KEY)) || {
            days: {}, availability: {}, logs: { cancellations: [] }, perks: {}, perkCodes: {},
            posts: [] // [{id, mediaType:'image'|'video', src:dataURL, caption, ts, likes, likedBy:{}, comments:[{id,firstName,lastName,text,ts}]}]
        };
    } catch {
        return { days: {}, availability: {}, logs: { cancellations: [] }, perks: {}, perkCodes: {}, posts: [] };
    }
}
function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
function ensureDB() {
    const db = loadDB();
    db.days = db.days || {};
    db.availability = db.availability || {};
    db.logs = db.logs || { cancellations: [] };
    db.perks = db.perks || {};
    db.perkCodes = db.perkCodes || {};
    db.posts = db.posts || [];
    // מיגרציה: ודא שלכל תגובה יש id
    db.posts.forEach(p => {
        p.comments = (p.comments || []).map(c => c && typeof c === 'object' ? ({ id: c.id || makeId(), ...c }) : c).filter(Boolean);
    });
    saveDB(db);
    return db;
}

/*** מזהה מכשיר ללייקים ***/
function getDeviceId() {
    let id = localStorage.getItem('aas_device_id');
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('aas_device_id', id); }
    return id;
}

/*** זמן/סלוטים ***/
function slotToHM(slot) { const minutes = slot * 30; return { h: Math.floor(minutes / 60), m: minutes % 60 }; }
function hmToSlot(h, m) { return Math.floor((h * 60 + m) / 30); }
function fmt2(n) { return String(n).padStart(2, '0'); }
function formatHM(h, m) { return `${fmt2(h)}:${fmt2(m)}`; }
function addMinutes(t, add) { const x = t.h * 60 + t.m + add; return { h: Math.floor(x / 60), m: (x % 60 + 60) % 60 }; }
function isWeekdaySunThu(dateStr) { const d = new Date(dateStr + 'T12:00'); const wd = d.getDay(); return wd >= 0 && wd <= 4; }

/*** זמינות ברירת מחדל: א'‑ה' 17:00–19:30 ***/
function getDefaultSlotsForDay(dayKey) {
    if (isWeekdaySunThu(dayKey)) {
        const from = hmToSlot(17, 0), to = hmToSlot(19, 30);
        const arr = []; for (let i = from; i <= to; i++) arr.push(i);
        return arr;
    }
    return [];
}
function getAllowedSlots(dayKey) {
    const db = ensureDB();
    const rec = db.availability[dayKey];
    return rec && Array.isArray(rec.slots) ? rec.slots.slice().sort((a, b) => a - b) : getDefaultSlotsForDay(dayKey);
}
function setAllowedSlots(dayKey, slots) {
    const db = ensureDB();
    const uniq = Array.from(new Set(slots)).filter(s => s >= 0 && s <= 47).sort((a, b) => a - b);
    db.availability[dayKey] = { slots: uniq };
    saveDB(db);
    localStorage.setItem(DB_KEY, JSON.stringify(db));
}
function enableSlotForDay(dayKey, slot) {
    const list = getAllowedSlots(dayKey);
    if (!list.includes(slot)) list.push(slot);
    setAllowedSlots(dayKey, list);
}
function disableSlotForDay(dayKey, slot) {
    const db = ensureDB();
    const list = getAllowedSlots(dayKey).filter(s => s !== slot);
    db.availability[dayKey] = { slots: list };
    if (db.days[dayKey]) {
        db.days[dayKey] = db.days[dayKey].filter(a => {
            const keep = a.baseSlot !== slot;
            if (!keep) db.logs.cancellations.push({ ts: Date.now(), dayKey, baseSlot: slot, by: 'admin/disabled', appt: a });
            return keep;
        });
        if (db.days[dayKey].length === 0) delete db.days[dayKey];
    }
    saveDB(db);
    localStorage.setItem(DB_KEY, JSON.stringify(db));
}

/*** "שעת אמת" ***/
function calcActualTime(appt, list) {
    const shifts = list.filter(a => a.baseSlot < appt.baseSlot && a.withScissors).length * 10;
    const baseHM = slotToHM(appt.baseSlot);
    return addMinutes(baseHM, shifts);
}
function sortByActual(a, b, list) {
    const ta = calcActualTime(a, list); const tb = calcActualTime(b, list);
    return (ta.h * 60 + ta.m) - (tb.h * 60 + tb.m);
}

/*** תורים ***/
function getDayList(dayKey) { const db = loadDB(); return (db.days[dayKey] || []); }
function addAppointment(dayKey, baseSlot, data) {
    const allowed = getAllowedSlots(dayKey);
    if (!allowed.includes(baseSlot)) throw new Error('הסלוט לא זמין ביום זה');
    const db = ensureDB(); db.days[dayKey] = db.days[dayKey] || [];
    if (db.days[dayKey].some(a => a.baseSlot === baseSlot)) throw new Error('השעה שבחרת כבר תפוסה');
    db.days[dayKey].push({ baseSlot, ...data, createdAt: Date.now() });
    saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db)); return true;
}
function removeAppointment(dayKey, baseSlot) {
    const db = ensureDB(); if (!db.days[dayKey]) return false;
    let removed = null;
    db.days[dayKey] = db.days[dayKey].filter(a => { const keep = a.baseSlot !== baseSlot; if (!keep && !removed) removed = a; return keep; });
    if (removed) {
        db.logs.cancellations.push({ ts: Date.now(), dayKey, baseSlot, by: 'admin', appt: removed });
        if (db.days[dayKey].length === 0) delete db.days[dayKey];
        saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db)); return true;
    }
    return false;
}

/*** ייצוא חודשי (CSV) ***/
function getAppointmentsInMonth(year, month) {
    const db = loadDB(); const prefix = `${year}-${String(month).padStart(2, '0')}`; const rows = [];
    Object.keys(db.days || {}).forEach(dayKey => {
        if (dayKey.startsWith(prefix)) {
            const list = db.days[dayKey] || [];
            list.slice().sort((a, b) => sortByActual(a, b, list)).forEach(a => {
                const t = calcActualTime(a, list);
                rows.push({
                    dayKey, time: formatHM(t.h, t.m),
                    firstName: a.firstName, lastName: a.lastName, phone: a.phone || '',
                    withScissors: !!a.withScissors, duration: a.withScissors ? 40 : 30, baseSlot: a.baseSlot
                });
            });
        }
    });
    rows.sort((x, y) => x.dayKey === y.dayKey ? x.time.localeCompare(y.time) : x.dayKey.localeCompare(y.dayKey));
    return rows;
}
function buildMonthlyCSV(year, month) {
    const rows = getAppointmentsInMonth(year, month);
    const header = ["Date", "Time", "First Name", "Last Name", "Phone", "With Scissors", "Duration (min)"];
    const lines = [header.join(",")];
    rows.forEach(r => {
        const phoneTxt = r.phone ? `="${r.phone.replace(/"/g, '""')}"` : '""';
        lines.push([
            r.dayKey, r.time,
            `"${r.firstName.replace(/"/g, '""')}"`,
            `"${r.lastName.replace(/"/g, '""')}"`,
            phoneTxt,
            r.withScissors ? "Yes" : "No",
            r.duration
        ].join(","));
    });
    return "\uFEFF" + lines.join("\r\n");
}

/*** מצטיין חודשי + קוד ***/
function ymKey(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }
function setMonthlyTopPerkWithCode(year, month, person) {
    const db = ensureDB(); const ym = ymKey(year, month);
    db.perks[ym] = person;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.perkCodes[ym] = { code, ts: Date.now(), sent: false };
    saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db));
    return code;
}
function getMonthlyTopPerk(year, month) { const db = ensureDB(); return db.perks[ymKey(year, month)] || null; }
function getMonthlyPerkCode(year, month) { const db = ensureDB(); const rec = db.perkCodes[ymKey(year, month)]; return rec ? rec.code : null; }
function markPerkCodeSent(year, month) { const db = ensureDB(); const ym = ymKey(year, month); if (db.perkCodes[ym]) { db.perkCodes[ym].sent = true; saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db)); } }
function getTopClientsInMonth(year, month) {
    const rows = getAppointmentsInMonth(year, month), map = new Map();
    const keyOf = (fn, ln, ph) => `${fn.trim().toLowerCase()}|${ln.trim().toLowerCase()}|${(ph || '').trim()}`;
    rows.forEach(r => { const k = keyOf(r.firstName, r.lastName, r.phone); if (!map.has(k)) map.set(k, { count: 0, row: r }); map.get(k).count++; });
    let max = 0; map.forEach(v => { if (v.count > max) max = v.count; });
    const tops = []; map.forEach(v => { if (v.count === max) tops.push({ count: v.count, row: v.row }); });
    return { tops, max };
}

/*** Google Calendar ***/
function toCalDt(dayKey, hm) { return dayKey.replace(/-/g, '') + 'T' + hm.replace(':', '') + '00'; }
function buildGCalLink({ title, dayKey, startHM, durationMin, details, location }) {
    const start = toCalDt(dayKey, startHM);
    const endHM = (function () {
        const [H, M] = startHM.split(':').map(Number);
        const end = addMinutes({ h: H, m: M }, durationMin);
        return formatHM(end.h, end.m);
    })();
    const end = toCalDt(dayKey, endHM);
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: title || 'תספורת',
        dates: `${start}/${end}`,
        details: details || '',
        location: location || 'Almog Asaf Barbershop'
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/*** ===== פוסטים: תמונות + וידאו ===== ***/
function makeId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function getPosts() { const db = ensureDB(); return db.posts.slice().sort((a, b) => b.ts - a.ts); }
function addPostMedia(mediaType, dataURL, caption) {
    if (mediaType !== 'image' && mediaType !== 'video') throw new Error('סוג מדיה לא נתמך');
    const db = ensureDB();
    const post = {
        id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        mediaType, src: dataURL,
        caption: (caption || '').trim(),
        ts: Date.now(),
        likes: 0,
        likedBy: {},
        comments: []
    };
    db.posts.push(post); saveDB(db);
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return post.id;
}
function toggleLike(postId) {
    const db = ensureDB(); const dev = getDeviceId();
    const p = db.posts.find(p => p.id === postId); if (!p) return null;
    if (p.likedBy[dev]) { delete p.likedBy[dev]; p.likes = Math.max(0, (p.likes || 0) - 1); }
    else { p.likedBy[dev] = true; p.likes = (p.likes || 0) + 1; }
    saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db));
    return { likes: p.likes, liked: !!p.likedBy[dev] };
}
function addComment(postId, firstName, lastName, text) {
    const db = ensureDB(); const p = db.posts.find(p => p.id === postId); if (!p) return false;
    p.comments.push({ id: makeId(), firstName: firstName.trim(), lastName: lastName.trim(), text: text.trim(), ts: Date.now() });
    saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db));
    return true;
}
function deletePost(postId) {
    const db = ensureDB();
    const before = db.posts.length;
    db.posts = db.posts.filter(p => p.id !== postId);
    const changed = db.posts.length !== before;
    if (changed) { saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db)); }
    return changed;
}
function deleteComment(postId, commentId) {
    const db = ensureDB();
    const p = db.posts.find(p => p.id === postId); if (!p) return false;
    const before = p.comments.length;
    p.comments = (p.comments || []).filter(c => c.id !== commentId);
    const changed = p.comments.length !== before;
    if (changed) { saveDB(db); localStorage.setItem(DB_KEY, JSON.stringify(db)); }
    return changed;
}
function isLikedByMe(postId) {
    const db = ensureDB(); const dev = getDeviceId();
    const p = db.posts.find(p => p.id === postId); if (!p) return false;
    return !!p.likedBy[dev];
}
