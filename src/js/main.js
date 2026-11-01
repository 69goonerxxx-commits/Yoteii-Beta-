import { esc, PALS, ACCENTS, onAccent } from './util.js';
import { validateBackup } from './validate.js';
import { TASK_LISTS, sameId, normalizeIds, removeTask, removeFromRecord } from './tasks.js';
import { store, initStore, info, onStoreError, replaceAll, clearAll, estimateBytes, makeSnapshot, snapshotIfDue, listSnapshots, restoreSnapshot } from './storage.js';
import { applyOvr, typeOfIn, buildSchedule, anchorNight } from './engine.js';
import { isoLocal, parseDay, dowOf, cmpDay } from './dates.js';
import { migrateDates, needsDateMigration, DATE_FMT } from './migrate.js';

// ---- running inside the Android app (Capacitor)? Plugins only exist there. ----
const CAPACITOR = window.Capacitor, IS_NATIVE = !!(CAPACITOR && CAPACITOR.isNativePlatform && CAPACITOR.isNativePlatform());
const nativePlugin = n => (IS_NATIVE && CAPACITOR.Plugins && CAPACITOR.Plugins[n]) || null;
import { guessIcon, ICONS, iconMarkup, ICON_GROUPS, ICON_TAGS } from './icons.js';
import { APP_VERSION, FEATURES, LIMITS, CHANGELOG } from './about.js';
import { TPL } from './templates.js';
import { SORTS, addedLabel, groups, stats, applyOrder, makeTask, insertNew, normalizePrefs } from './inbox.js';
import { addDays, isOverdue, overdueCount, quickDate, weekDays, shiftMonth, monthGrid, logDone, unlogDone } from './todo.js';
import { BLOCK_INFO, SCI_SRC, PRESS_PTS, CIRC_PTS } from './science.js';
import { historyHtml } from './history.js';
import { analyze as rhyAnalyze, suggest as rhySuggest, curve as rhyCurve, clean as rhyClean, nudgeTimes } from './rhythm.js';
import { startWaves } from './wave.js';
import { initEdUI } from './edui.js';
import { planTypes, ownNameError, sleepRangeFor } from './setupplan.js';
let EDUI = null;
// ============================================================
// YOTEI — script map (search for the header text to jump)
//   STORAGE & CONFIG            SEED DATA
//   APP STATE                   TIME HELPERS
//   SCHEDULING ENGINE           ICONS, COLOR, DOT SIZE/FILL
//   WINDOW-BLOCK EDITOR         DATA ACCESS & MIGRATION
//   TASK EDITOR                 TASK DETAIL SHEET
//   SUBTASK SHEET               HISTORY & TRENDS TABS
//   MAIN RENDER LOOP            NOW BANNER, CHIME, CLOCK
//   IMPORT / EXPORT / RESET     GESTURES
//   TABS & INIT
// ============================================================
// ============================================================
// STORAGE & CONFIG
// ============================================================
const $ = s => document.querySelector(s);
let toastT = null, toastUntil = 0, toastShownAt = 0;   // toast state (see toast() below)
await initStore();   // load everything saved on this device before the app starts
await upgradeDates();
// v2 stored days as "Sun Oct 11 2026"; v3 uses "2026-10-11". Converted once, with a snapshot of the old data kept first.
async function upgradeDates(){
  if (store.get('dateFmt', null) === DATE_FMT) return;
  const data = store.dump();
  if (Object.keys(data).length){
    try{ await makeSnapshot('before-upgrade'); }catch{}
    const next = migrateDates(data);
    try{ await replaceAll(next); }
    catch{ Object.entries(next).forEach(([k, v]) => store.setRaw(k, v)); }   // couldn't save in one step: carry on in memory, the app warns and retries on the next launch
  }
  store.set('dateFmt', DATE_FMT);
}
// Saving can fail (storage full, or blocked in private mode). Say so, at most once every 15 seconds, and offer a backup.
let lastSaveWarn = 0;
function storeFailed(){
  const now = Date.now(); if (now - lastSaveWarn < 15000) return; lastSaveWarn = now;
  if (document.getElementById('toastMsg')) toast("Couldn't save your changes. Storage may be full or blocked. Back up now so nothing is lost.", 'Back up', exportData);
}
onStoreError(() => storeFailed());
snapshotIfDue().catch(() => {});   // first launch of the day: keep a snapshot of how things were
const DEF_WAKE = 300;                      // 5:00 AM, in minutes after midnight
// Sleep caps have no built-in times: they stay off until you set both in Settings, Schedule (or answer the bedtime question in setup).
const CAP = { soft: null, hard: null };
{ const sv = store.get('caps', {}); if (sv && Number.isFinite(sv.soft) && Number.isFinite(sv.hard)){ CAP.soft = sv.soft; CAP.hard = sv.hard; } }
const capsOn = () => Number.isFinite(CAP.soft) && Number.isFinite(CAP.hard);
let capDraft = { soft: CAP.soft, hard: CAP.hard };   // what the two time rows show while only one of them is set

// Shrink order when the morning runs late: opt -> flex -> core. Each block can shrink down to m (min minutes).
// ============================================================
// SEED DATA — built-in defaults, used until the user edits a list
// (see getBlocks/setBlocks below for how overrides replace these)
// ============================================================
const PRE = [];   // no built-in tasks: you add your own
const NIGHT = [];
const MODES = {
  home: { deadline:null, msg:'No fixed departure. The day flows from your wake time.', post:[]},
  school: { deadline:6*60, post:[]},
  away: { deadline:null, msg:'Set the wake time for where you are and everything shifts with it.', post:[] }
};

const WIN = {
  sleep:{ name:'Morning routine', from:0, to:60, note:'Sleep inertia: grogginess usually fades over the first hour or so.' },
  climb1:{ name:'First Climb', from:60, to:180, note:'Alertness tends to climb toward a first peak. Outdoor light can help.' },
  peak:{ name:'Sustained Peak', from:180, to:360, note:'For many people this is a strong focus window.' },
  trough:{ name:'Afternoon Dip', from:360, to:480, note:'Many people dip after lunch. Alertness often drops.' },
  climb2:{ name:'Second Climb', from:480, to:720, note:'Often a second peak, sometimes as strong as the morning one.' },
  wmz:{ name:'Evening Alert Zone', from:720, to:900, note:'Many people find it hard to fall asleep here, and naps tend not to help.' },
  wind:{ name:'Night Routine', from:900, to:1080, note:'The same every night. Slow down and get ready for sleep.' }
};
const MODE_NAME = { home:'at home', school:'at school', away:'away' };
MODES.none = { deadline:null, msg:'Choose where you are for First Climb below to see the rest of the day. The morning routine is the same for every type.', post:[] };
// School leave time: a setting instead of a fixed 6:00 AM. With none set, School days run like Home days.
// People who already used the app keep the old 6:00 AM once, so their school mornings do not change under them.
let LEAVE = store.get('leave', undefined);
if (LEAVE === undefined && !store.get('capsNote', false) && (store.get('setup', false) || store.get('welcomed', false))){ LEAVE = 6 * 60; store.set('leave', LEAVE); }
if (!Number.isFinite(LEAVE)) LEAVE = null;
let LEAVE_FOR = store.get('leaveFor', 'school');
function applyLeave(){
  if (typeof LEAVE_FOR !== 'string' || !MODES[LEAVE_FOR] || LEAVE_FOR === 'home' || LEAVE_FOR === 'away' || LEAVE_FOR === 'none') LEAVE_FOR = 'school';
  Object.keys(MODES).forEach(k => { if (k !== 'home' && k !== 'away' && k !== 'none'){ MODES[k].deadline = k === LEAVE_FOR ? LEAVE : null; if (k !== 'school') MODES[k].msg = ''; } });
  MODES.school.msg = (LEAVE_FOR === 'school' && LEAVE === null) ? 'No leave time set, so this day runs like Home. Add one in Settings, Schedule and the morning routine will shrink to fit it.' : '';
  if (LEAVE_FOR !== 'school' && MODES[LEAVE_FOR]) MODES[LEAVE_FOR].msg = LEAVE === null ? 'No leave time set, so this day runs like Home. Add one in Settings, Schedule and the morning routine will shrink to fit it.' : '';
}
applyLeave();
Object.values(MODES).forEach(M => M.post.forEach(b => { b.w = b.w || 'climb1'; }));
// ============================================================
// APP STATE — in-memory + localStorage-backed
// ============================================================
let mode = null;
let wake = store.get('wake', DEF_WAKE);
if (typeof wake !== 'number') wake = (wake && wake.home) || DEF_WAKE;
let done = null, day = null, plans = store.get('plans', {});
let openState = store.get('open', {});
let editing = false, cur = null, edDays = [];
let noteEditing = null;
const todayStr = () => isoLocal(new Date());
let viewDate = todayStr();
loadDay(viewDate);
function defWake(){ const w = store.get('wake', DEF_WAKE); return typeof w === 'number' ? w : ((w && w.home) || DEF_WAKE); }
function planFor(ds){
  if (plans[ds]) return plans[ds];
  const L = store.get('day', null), D = store.get('done', null);
  if (L && L.date === ds && L.types) return { w:defWake(), d:(D && D.date === ds ? D.ids : []), t:L.types, a:!!L.away, n:L.note || '' };
  const h = ds < todayStr() ? store.get('hist', {})[ds] : null;
  if (h) return { w:h.wake, d:(h.rows || []).filter(r => r.done).map(r => r.id), t:h.types || {}, a:false, n:h.note || '' };
  return null;
}
function loadDay(ds){
  const p = planFor(ds);
  wake = p ? p.w : defWake();
  done = { date:ds, ids:p ? (p.d || []).slice() : [] };
  day = { date:ds, types:p ? { ...(p.t || {}) } : usualTypes(ds), away:p ? !!p.a : false, note:p ? (p.n || '') : '', oneoffs:p && p.o ? p.o.slice() : [], live:!!(p && p.l), shift:p && p.s ? p.s : null };
  if (p && p.p) day.prevTypes = p.p;
}
function saveDay(){
  plans[viewDate] = { w:wake, d:done.ids, t:day.types, a:!!day.away, n:day.note || '', p:day.prevTypes || null, o:day.oneoffs || [], l:!!day.live, s:day.shift || null };
  const ks = Object.keys(plans).sort(cmpDay);
  while (ks.length > 200) delete plans[ks.shift()];
  store.set('plans', plans);
  if (viewDate === todayStr()) store.set('wake', wake);
  if (viewDate <= todayStr()) saveHist();
}
function goDate(ds){ viewDate = ds; noteEditing = null; loadDay(ds); render(); }
const shownNotes = new Set();
function noteKey(id){ return viewDate + '_' + id; }
function getNote(id){ return store.get('taskNotes', {})[noteKey(id)] || ''; }
function setNote(id, txt){
  const nm = store.get('taskNotes', {}), k = noteKey(id);
  if (txt) nm[k] = txt; else delete nm[k];
  store.set('taskNotes', nm);
}


// ============================================================
// TIME HELPERS
// ============================================================
let CLOCK24 = store.get('clock', '12') === '24';
function fmt(m){
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(m/60), mm = m % 60;
  if (CLOCK24) return [String(h).padStart(2,'0') + ':' + String(mm).padStart(2,'0'), ''];
  return [((h+11)%12+1) + ':' + String(mm).padStart(2,'0'), h < 12 ? 'AM' : 'PM'];
}
const clk = m => fmt(m).join(' ').trim();   // '11:00 PM', or '23:00' on a 24-hour clock
function range(a, b){
  const x = fmt(a), y = fmt(b);
  return (x[1] === y[1] ? x[0] : x[0]+' '+x[1]) + ' – ' + y[0] + ' ' + y[1];
}
function mondayOf(ds){
  const d = parseDay(ds), wd = d.getDay(), diff = (wd === 0 ? -6 : 1 - wd);
  const m = new Date(d); m.setDate(d.getDate() + diff); return m;
}
function winFor(clock, wk){
  const WB = wins(), n = clock - (wk === undefined ? wake : wk), keys = Object.keys(WB); if (n < 0) return 'sleep';
  let w = keys[0]; for (const k of keys) if (n >= WB[k].from) w = k; return w;
}
const toVal = m => String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');

// ============================================================
// SCHEDULING ENGINE — turns blocks + wake time into timed rows
// NOTE: window from/to are labels, not hard constraints — a task
// can run past its window's nominal end (see the 'runs past
// window end' tag in rowHtml, and isNowW's overflow-aware check).
// ============================================================
function build(dow){
  dow = dow === undefined ? new Date().getDay() : dow;
  return buildSchedule({ dow, wake, day, CAP, MODES, WIN, OV: store.get('ovr', {}), getBlocks, wins, fmt });
}

const nowM = () => { const d = new Date(); return d.getHours()*60 + d.getMinutes(); };
// ============================================================
// ICONS, COLOR, DOT SIZE/FILL — visual helpers for the timeline
// ============================================================
const MODE_LABEL = { home:'Home', school:'School', away:'Away' };
function onColor(c){
  const m = /^#([0-9a-f]{6})$/i.exec((c || '').trim()); if (!m) return '#fff';
  const v = [0, 2, 4].map(i => { const x = parseInt(m[1].substr(i, 2), 16) / 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); });
  return (.2126 * v[0] + .7152 * v[1] + .0722 * v[2]) > .3 ? '#06121f' : '#fff';
}
const DOT_W = 56;
function dotHeight(use){
  const BASE = 56, MAX = 150, CAP_AT = 120; // minutes at which height maxes out
  if (!use || use <= 10) return BASE;
  const t = Math.min(1, (use - 10) / (CAP_AT - 10));
  return Math.round(BASE + t * (MAX - BASE));
}
function fracFor(r, NM){
  if (r.start === undefined || r.end === undefined || r.end <= r.start) return NM >= (r.start || 0) ? 1 : 0;
  if (NM <= r.start) return 0;
  if (NM >= r.end) return 1;
  return (NM - r.start) / (r.end - r.start);
}
function buildSpine(){
  const wrap = document.querySelector('#tl .tlwrap'); if (!wrap) return;
  wrap.querySelectorAll('.tlseg,.tlspine').forEach(e => e.remove());
  const wr = wrap.getBoundingClientRect(), GRAY = 'var(--graydot)', nodes = [], sc = (wr.width / (wrap.offsetWidth || wr.width)) || 1;   // sc corrects for large-text zoom
  const okc = c => (c && CSS.supports('color', c)) ? String(c).trim() : GRAY;
  Array.from(wrap.children).forEach(el => {
    if (el.matches('.gap') && nodes.length){ nodes[nodes.length - 1].gap = true; return; }
    if (!el.matches('.blk,.tlhead')) return;
    const dot = el.querySelector('.tldot'); if (!dot) return;
    const r = dot.getBoundingClientRect(), f = parseFloat(el.dataset.f);
    nodes.push({ c:okc(el.dataset.c), f:isFinite(f) ? f : 0, top:(r.top - wr.top) / sc, bottom:(r.bottom - wr.top) / sc, x:(r.left - wr.left + r.width / 2) / sc });
  });
  const oklab = CSS.supports('background-image', 'linear-gradient(in oklab to bottom, red, blue)') ? 'in oklab ' : '';
  for (let k = 0; k < nodes.length - 1; k++){
    const a = nodes[k], b = nodes[k + 1];
    const from = a.f >= 1 ? a.c : GRAY, to = b.f > 0 ? b.c : GRAY, top = a.bottom - 3, h = b.top - a.bottom + 6;
    if (h <= 0) continue;
    const seg = document.createElement('i'); seg.className = 'tlseg' + (a.gap ? ' dash' : '');
    seg.style.setProperty('--c', from); seg.style.cssText += ';left:' + (a.x - 3) + 'px;top:' + top + 'px;height:' + h + 'px;background:' + (from.toLowerCase() === to.toLowerCase() ? from : 'linear-gradient(' + oklab + 'to bottom,' + from + ' 0%,' + from + ' 16%,' + to + ' 84%,' + to + ' 100%)');
    wrap.appendChild(seg);   // appended last: inserting it first would flip .tlhead:first-child and shift everything 10px
  }
}
window.addEventListener('resize', buildSpine);
if (document.fonts) document.fonts.addEventListener('loadingdone', buildSpine);
if (window.ResizeObserver) new ResizeObserver(() => buildSpine()).observe(document.getElementById('tl'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildSpine);
function dotFillHtml(iconKey, color, frac, h){
  h = h || 56;
  const cov = Math.round(Math.max(0, Math.min(1, (frac * h - (h - 28) / 2) / 28)) * 100), svg = ICONS[iconKey];
  return svg ? '<span class="dotIconWrap"><span class="dotIconTop" style="clip-path:inset(0 0 ' + (100 - cov) + '% 0);color:' + onColor(color) + '">' + svg + '</span><span class="dotIconBot" style="clip-path:inset(' + cov + '% 0 0 0);color:' + color + '">' + svg + '</span></span>' : '<span class="dotIconPlain">' + esc(iconKey) + '</span>';
}
function dotBg(color, frac){
  if (frac <= 0) return 'var(--dotbg)';
  if (frac >= 1) return color;
  return 'var(--dotbg)';      // a task that is running now is filled by the wave (wave.js)
}
let wvN = 0;
function waveHtml(iconKey, color, frac, h){
  const id = ++wvN, svg = ICONS[iconKey] || '';
  const ic = c => svg.replace(/<svg\b/, '<svg x="14" y="' + (h / 2 - 14) + '" width="28" height="28" style="color:' + c + '"').replace(/\s(width|height)="[^"]*"/g, (m, a, i) => m);
  const dark = onColor(color);
  return '<svg class="dotWv" viewBox="0 0 ' + DOT_W + ' ' + h + '" data-f="' + frac.toFixed(3) + '" data-h="' + h + '" aria-hidden="true"><defs><clipPath id="wq' + id + '"><path class="wF"/></clipPath><clipPath id="wb' + id + '"><path class="wB"/></clipPath></defs>' +
    ic(color) + '<g clip-path="url(#wb' + id + ')"><rect width="' + DOT_W + '" height="' + h + '" fill="' + color + '" opacity=".45"/></g>' +
    '<g clip-path="url(#wq' + id + ')"><rect width="' + DOT_W + '" height="' + h + '" fill="' + color + '"/>' + ic(dark) + '</g></svg>';
}
const WIN_STYLE = {
  sleep:{ c:'#f59e0b', i:'sunrise' }, climb1:{ c:'#f97316', i:'mountain' }, peak:{ c:'#facc15', i:'brain' },
  trough:{ c:'#38bdf8', i:'coffee' }, climb2:{ c:'#34d399', i:'rocket' }, wmz:{ c:'#a78bfa', i:'eye' }, wind:{ c:'#6366f1', i:'moon' }
};
function typeOf(k){ return typeOfIn(day.types, k, WIN); }
function schedule(){
  const sn = snapRows();
  if (sn) return { rows:sn, msg:'Saved record of this day. Edit anything and it rebuilds from your current routines.', tone:'ok' };
  return build(parseDay(viewDate).getDay());
}
let pickOpen = null;   // which block's day-type picker is open
function pickType(k, m){ needLive(); day.types[k] = m; pickOpen = null; saveDay(); render(); }
// ============================================================
// WINDOW-BLOCK EDITOR (the settings dialog for one window)
// ============================================================
const CHRONO = { early:-30, normal:0, late:45 };
// My rhythm: the same shift for every energy window, learned from your own ratings (see rhythm.js). It only ever suggests; you decide.
const rhyState = () => { const r = store.get('rhythm', {}); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; };
const myShift = () => { const s = rhyState().shift; return Number.isFinite(s) ? s : 0; };
const shiftInUse = () => { const m = store.get('chrono', 'normal'); return m === 'mine' ? myShift() : (CHRONO[m] || 0); };
let rhyCache = { key:'', a:null };   // the reading is cached, so redrawing the app does not redo the maths
function rhyRead(){
  const L = store.get('energy', []), t = todayStr();
  const key = L.length + '|' + t + '|' + L.reduce((s, r, i) => s + ((r && r.v) || 0) * (i + 1) + ((r && r.o) || 0), 0);
  if (rhyCache.key !== key) rhyCache = { key, a:rhyAnalyze(L, t) };
  return rhyCache.a;
}
// With a bedtime set, the night window is fixed to it. A later shift would squeeze the Evening Alert Zone into that window, so the shift is
// held back to keep the zone at least 30 min long. No bedtime = the night window moves with your rhythm, so there is nothing to protect.
function rhyGuard(a){
  if (!capsOn()) return null;
  return { wake:Number.isFinite(a.usualWake) ? a.usualWake : wake, hardCap:CAP.hard, nightMin:(WIN.wind.to - WIN.wind.from) + 30, windFrom:WIN.wmz.from };
}
const rhyAsk = (a, over) => rhySuggest(a, { current:shiftInUse(), today:todayStr(), never:!!rhyState().never, snooze:rhyState().snooze || null, guard:rhyGuard(a), ...(over || {}) });
const shiftWords = n => n === 0 ? 'as planned' : Math.abs(n) + ' min ' + (n < 0 ? 'earlier' : 'later');
const winBase = k => {
  const sh = shiftInUse(), b = { ...WIN[k], ...(k === 'sleep' ? {} : { from:WIN[k].from + sh, to:WIN[k].to + sh }) };
  if (capsOn() && (k === 'wmz' || k === 'wind')){   // a bedtime is set: the night window is the 3 hours before it, whatever your rhythm
    const a = anchorNight({ wmz:{ from:WIN.wmz.from + sh, to:WIN.wmz.to + sh }, wind:{ from:WIN.wind.from + sh, to:WIN.wind.to + sh } }, wake, CAP.hard);
    return { ...b, ...a[k] };
  }
  return b;
};
const wins = () => {
  const o = store.get('wins', {}), W = store.get('wovr', {}), r = {};
  for (const k in WIN) r[k] = { ...winBase(k), ...(o[k] || {}) };
  if (day && day.date){
    const iso = day.date, dow = dowOf(day.date);
    for (const k in W) (W[k] || []).forEach(e => {
      if (!r[k] || (e.from && iso < e.from) || (e.to && iso > e.to) || (e.days && !e.days.includes(dow))) return;
      Object.keys(e.patch).forEach(f => { if (e.patch[f] === null) delete r[k][f]; else r[k][f] = e.patch[f]; });
    });
  }
  return r;
};
function openBlockEd(k){
  const W = wins()[k];
  cur = { l:'win', id:k, w:k, wk:k };
  $('#ed').dataset.mode = 'win'; $('#e_title').textContent = 'Edit window';
  $('#e_tlab').textContent = 'Window name'; $('#e_dlab').textContent = 'Note';
  $('#e_t').value = W.name; $('#e_icon').value = W.icon || WIN_ICON_DEF[k]; updateIconBtn();
  $('#e_color').value = W.color || ''; CT = 'e'; drawColorRow('e'); setEdAccent();
  $('#e_bs').value = toVal(wake + W.from); $('#e_be').value = toVal(wake + W.to);
  $('#e_details').value = W.note || '';
  $('#e_wrap').style.display = 'none';
  $('#e_del').textContent = 'Reset to default times'; $('#e_del').style.display = '';
  ['e_up', 'e_dn'].forEach(i => { $('#' + i).style.display = 'none'; });
  $('#ed').showModal(); $('#ed .ef').scrollTop = 0;
}
function saveWinBlock(name){
  const k = cur.id, a = ($('#e_bs').value || '00:00').split(':').map(Number), z = ($('#e_be').value || '00:00').split(':').map(Number);
  let from = a[0] * 60 + a[1] - wake, to = z[0] * 60 + z[1] - wake; if (from < 0) from += 1440; if (to < 0) to += 1440;
  if (to <= from){ edErr('A block has to end after it starts.'); return; }
  const o = wins()[k];
  askScope('edit', { l:'win', id:k,
    b:{ name, note:$('#e_details').value.trim(), color:$('#e_color').value || null, icon:$('#e_icon').value.trim() || WIN_ICON_DEF[k], from, to },
    old:{ name:o.name, note:o.note || '', color:o.color || null, icon:o.icon || WIN_ICON_DEF[k], from:o.from, to:o.to } });
}
// ============================================================
// DATA ACCESS & MIGRATION
// schemaV gates one-time migrations; bump it if you add another.
// ============================================================
const clone = a => JSON.parse(JSON.stringify(a));
function migrateFields(){
  if (store.get('schemaV', 0) >= 1){ return; }
  const blocks = store.get('blocks', null);
  if (blocks){
    let changed = false;
    for (const l in blocks){
      const arr = blocks[l];
      if (!Array.isArray(arr)) continue;
      for (const b of arr){
        if (b && b.s !== undefined){
          if (!b.details) b.details = b.s;
          delete b.s;
          changed = true;
        }
      }
    }
    if (changed) store.set('blocks', blocks);
  }
  store.set('schemaV', 1);
}
function getBlocks(l){
  if (l === 'oo') return day.oneoffs || [];
  const b = store.get('blocks', null);
  return b && b[l] ? b[l] : (l === 'pre' ? PRE : l === 'night' ? NIGHT : (MODES[l] || MODES.home).post);
}
function setBlocks(l, arr){ if (l === 'oo'){ day.oneoffs = arr; saveDay(); return; } const b = store.get('blocks', null) || {}; b[l] = arr; store.set('blocks', b); }
// ============================================================
// TASK EDITOR (the main add/edit-task dialog, #ed)
// ============================================================
function drawDays(){
  $('#e_days').innerHTML = ['Su','Mo','Tu','We','Th','Fr','Sa'].map((n, i) => '<button type="button" data-i="' + i + '"' + (edDays.includes(i) ? ' class="on"' : '') + '>' + n + '</button>').join('');
}
function effBlock(l, b){
  if (!b || l === 'oo') return b;
  const m1 = typeOf('climb1'), dm = m1 || Object.values(day.types || {})[0] || null;
  return applyOvr(b, store.get('ovr', {}), viewDate, parseDay(viewDate).getDay(), dm) || b;
}
const KIND_HINT = {
  core:'Shrinks last when time is tight. This only matters in the Morning and Night routines.',
  flex:'Shrinks first when time is tight. This only matters in the Morning and Night routines.',
  opt:'Cut first when time is tight. This only matters in the Morning and Night routines.',
  fixedlen:'Keeps its length and never shrinks. Add a Start time to pin it to a clock time.',
  sug:'A suggestion with no time. It shows on the timeline without taking any.',
  open:'Keeps its length, like Fixed length. Use it for a slot you will fill in later.'
};
function applyKindUI(){
  const k = $('#e_k').value, sug = k === 'sug', pri = ['core', 'flex', 'opt'].includes(k);
  $('#e_khint').textContent = KIND_HINT[k] || '';
  $('#e_howlong').style.display = sug ? 'none' : '';
  $('#e_se').style.display = sug ? 'none' : '';
  $('#e_mrow').style.display = sug ? 'none' : '';
  $('#e_fxrow').style.display = sug ? 'none' : '';
  $('#e_mwrap').style.display = pri ? '' : 'none';
}
function setKind(v){ $('#e_k').value = v; applyKindUI(); }
function refreshWinLock(){
  const on = !!$('#e_s').value && $('#e_wrap').style.display !== 'none';
  $('#e_w').disabled = on;
}
// The list a row says it belongs to can be wrong for data saved by older versions; find where the task really is.
function resolveList(l, id){
  if (!id || l === 'oo' || l === 'win' || getBlocks(l).some(x => sameId(x.id, id))) return l;
  return TASK_LISTS.find(x => x !== l && getBlocks(x).some(y => sameId(y.id, id))) || l;
}
function openEd(l, id, w, startAt){
  l = resolveList(l, id);
  const b = id ? effBlock(l, getBlocks(l).find(x => sameId(x.id, id))) : null;
  if (id && !b){ toast('That task is no longer in your routines.', 'Delete it', () => ghostDelete(l, id)); return; }
  cur = { l, id, w, wk: l === 'pre' ? 'sleep' : l === 'night' ? 'wind' : ((b && b.w) || w || 'climb1'), isNew: !b };
  edTypes = (b && WIN_LISTS.includes(l)) ? linkedTypes(l, b) : null; edTypesOrig = edTypes ? edTypes.slice() : null;
  $('#e_title').textContent = (b ? 'Edit' : 'New') + ' task';
  $('#e_err').hidden = true;
  $('#ed').dataset.mode = 'task'; $('#e_tlab').textContent = 'Task'; $('#e_dlab').textContent = 'Details'; $('#e_del').textContent = 'Delete task';
  $('#e_wrap').style.display = l === 'oo' ? '' : 'none';
  if (l === 'oo'){ const WB = wins(); $('#e_w').innerHTML = Object.keys(WB).map(k => '<option value="' + k + '">' + esc(WB[k].name) + '</option>').join(''); $('#e_w').value = (b && b.w) || w || 'climb1'; }
  const x = b || { t:'', d:20 };
  $('#e_t').value = x.t;
  $('#e_k').value = x.sug ? 'sug' : x.p === 'open' ? 'open' : ['core','flex','opt'].includes(x.p) ? x.p : 'fixedlen';
  $('#e_d').value = x.d; $('#e_m').value = x.m ?? ''; highlightChip();
  $('#e_icon').value = x.icon || ''; updateIconBtn();
  $('#e_color').value = x.color || ''; CT = 'e'; drawColorRow('e'); setEdAccent();
  let st = x.fixed !== undefined ? x.fixed : x.at;
  if (startAt !== undefined && !b) st = startAt;
  $('#e_fx').checked = x.fixed !== undefined;
  endDriven = false; $('#e_s').value = st !== undefined ? toVal(st) : ''; $('#e_e').value = '';
  syncEnd(); refreshWinLock(); applyKindUI();
  $('#e_days').style.display = l === 'oo' ? 'none' : '';
  $('#e_dates').style.display = l === 'oo' ? 'none' : ''; $('#e_from').value = x.from || ''; $('#e_to').value = x.to || '';
  drawEdTypes();
  $('#e_details').value = x.details || ''; edSteps.set(x.steps);
  edDays = x.days ? x.days.slice() : [0,1,2,3,4,5,6]; drawDays();
  ['e_del','e_up','e_dn'].forEach(i => { $('#' + i).style.display = b ? '' : 'none'; });
  $('#ed').showModal(); $('#ed .ef').scrollTop = 0;
}
function moveBlock(d){
  const arr = clone(getBlocks(cur.l)), i = arr.findIndex(x => sameId(x.id, cur.id)), wk = x => x.w || 'climb1';
  if (i < 0) return;
  if (arr[i].fixed !== undefined || arr[i].at !== undefined){ edErr('This task has a Start time, so it is ordered by that time. Change the Start time instead.'); return; }
  const vis = new Set(schedule().rows.map(r => r.id));
  let j = i + d;
  while (j >= 0 && j < arr.length && (wk(arr[j]) !== wk(arr[i]) || !vis.has(arr[j].id) || arr[j].fixed !== undefined || arr[j].at !== undefined)) j += d;
  if (j < 0 || j >= arr.length){ edErr(d < 0 ? 'It is already first in this window.' : 'It is already last in this window.'); return; }
  needLive();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  setBlocks(cur.l, arr); $('#ed').close(); render();
}
function edErr(msg){ const e = $('#e_err'); e.textContent = msg; e.hidden = false; try{ e.scrollIntoView({ block:'center', behavior:'smooth' }); }catch{} }
// Day types: which of Home / School / Away a task is added to. A task in several types is saved as one copy per type,
// tied together by a shared link key (lk), so editing one updates the others.
const WIN_LISTS = ['home', 'school', 'away'];
// Custom day types. Home, School and Away are built in; Work and Sick come ready-made and can be renamed or deleted, and you can add more.
const BUILTIN_TYPES = { home:'Home', school:'School', away:'Away' };
const SLOT_DEF = { school:'School', away:'Away' };
function slotNames(){
  const o = store.get('slotNames', {}), r = {};
  if (o && typeof o === 'object'){
    ['school', 'away'].forEach(k => {
      const v = typeof o[k] === 'string' ? o[k].trim().replace(/\s+/g, ' ').slice(0, 14) : '', lv = v.toLowerCase();
      if (v && lv !== 'home' && !Object.values(SLOT_DEF).some(d => d.toLowerCase() === lv)) r[k] = v;
    });
    if (r.school && r.away && r.school.toLowerCase() === r.away.toLowerCase()) delete r.away;
  }
  return r;
}
// Work and Sick used to come ready-made. They no longer do, but anyone who already put tasks or days in them keeps them.
function legacyTypes(){
  const b = store.get('blocks', null) || {}, pl = Object.values(store.get('plans', {}) || {}), us = Object.values(store.get('usual', {}) || {});
  const used = id => (b[id] && b[id].length) || pl.some(p => p && p.t && Object.values(p.t).includes(id)) || us.includes(id);
  return [{ id:'work', name:'Work' }, { id:'sick', name:'Sick' }].filter(t => used(t.id));
}
function dayTypes(){ const s = store.get('dayTypes', null); return Array.isArray(s) ? s.filter(x => x && x.id && x.name) : legacyTypes(); }
function syncTypes(){        // rebuild every list the app keeps of day types, in place so the rest of the code sees the change
  const sn = slotNames(), NN = { Work:'at work', Sick:'sick' };
  Object.assign(BUILTIN_TYPES, { home:'Home', school:sn.school || 'School', away:sn.away || 'Away' });
  MODE_NAME.school = sn.school ? (NN[sn.school] || sn.school) : 'at school'; MODE_NAME.away = sn.away ? (NN[sn.away] || sn.away) : 'away';
  Object.keys(MODE_LABEL).forEach(k => { delete MODE_LABEL[k]; });
  Object.assign(MODE_LABEL, BUILTIN_TYPES);
  dayTypes().forEach(t => { MODE_LABEL[t.id] = t.name; MODE_NAME[t.id] = t.name; if (!MODES[t.id]) MODES[t.id] = { deadline:null, msg:'', post:[] }; });
  WIN_LISTS.length = 0; Object.keys(MODE_LABEL).forEach(k => WIN_LISTS.push(k));
  TASK_LISTS.length = 0; ['pre', 'night'].concat(WIN_LISTS).forEach(k => TASK_LISTS.push(k));
  applyLeave();
}
syncTypes();
let edTypes = null, edTypesOrig = null;   // null = not chosen yet, show the default
const newTaskId = n => 'u' + Date.now().toString(36) + (n || 0) + Math.random().toString(36).slice(2, 5);
function linkedTypes(l, b){ return !b.lk ? [l] : WIN_LISTS.filter(L => L === l || getBlocks(L).some(x => x.lk && x.lk === b.lk)); }
function typesVisible(){
  if (WIN_LISTS.includes(cur.l)) return true;
  return cur.l === 'oo' && !!cur.addScope && !!cur.isNew && !['sleep', 'wind'].includes($('#e_w').value || 'climb1');
}
function defaultType(){ return WIN_LISTS.includes(cur.l) ? cur.l : (typeOf($('#e_w').value || 'climb1') || 'home'); }
const shownTypes = () => edTypes || [defaultType()];
function drawEdTypes(){
  const vis = typesVisible(); $('#e_typesWrap').style.display = vis ? '' : 'none'; if (!vis) return;
  const on = shownTypes();
  $('#e_types').innerHTML = WIN_LISTS.map(m => '<button type="button" data-m="' + m + '"' + (on.includes(m) ? ' class="on"' : '') + '>' + MODE_LABEL[m] + '</button>').join('');
}
$('#e_types').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const m = b.dataset.m, on = shownTypes(), next = on.includes(m) ? on.filter(x => x !== m) : on.concat(m);
  if (!next.length){ edErr('A task needs at least one day type.'); return; }
  edTypes = WIN_LISTS.filter(x => next.includes(x)); drawEdTypes();
});
$('#e_w').addEventListener('change', drawEdTypes);
let endDriven = false;   // true while the Start was worked out from the End and the length (End entered first)
function startFromEnd(){
  const e = $('#e_e').value; if (!e) return false;
  if ($('#e_k').value === 'sug') setKind('fixedlen');
  let d = parseInt($('#e_d').value) || 0;
  if (!d){ d = 20; $('#e_d').value = d; highlightChip(); }
  const [h2, m2] = e.split(':').map(Number), st = h2 * 60 + m2 - d;
  if (st < 0){ edErr('That end time is too early for a ' + d + '-minute task. Pick a later end time or a shorter length.'); return false; }
  $('#e_s').value = toVal(st); endDriven = true; syncWinSel(); refreshWinLock();
  return true;
}
function syncEnd(){
  if (endDriven) return;
  const s = $('#e_s').value, d = parseInt($('#e_d').value) || 0;
  if (!s || !d){ $('#e_e').value = ''; return; }
  const [h, mi] = s.split(':').map(Number), t = h*60 + mi + d;
  $('#e_e').value = t <= 1439 ? toVal(t) : '';
}
function highlightChip(){ const v = $('#e_d').value; document.querySelectorAll('#e_presets button').forEach(b => b.classList.toggle('on', b.dataset.m === v)); }
function updateIconBtn(){ const v = $('#e_icon').value; $('#e_iconBtn').innerHTML = v ? iconMarkup(v) : '+'; }
const ICON_CAT = {'Body & movement':'run','Food & drink':'meal','Mind & focus':'bulb','Rest & time':'moon','Home & social':'home','Travel & errands':'bag','Health & care':'heartbeat','Study & work':'books','Money & shopping':'basket','Chores & home':'broom','Social & fun':'confetti','Music & media':'music-note','Sports & outdoors':'soccer-ball','Nature & weather':'cloud-sun','Animals':'dog','Travel & places':'airplane-takeoff','Tech & settings':'desktop','More food & drink':'pizza'};
function catIcon(g){ const k = ICON_CAT[g] || (ICON_GROUPS[g] || [])[0]; return ICONS[k] || ICONS.star || ''; }
function ipId(g){ return 'ipg_' + g.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
const FA_VER = '6.7.2', FA_URL = n => 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@' + FA_VER + '/svgs/solid/' + n + '.svg';
const FA_GROUPS = {
  'Bathroom':['shower','toilet','toilet-paper','bath','soap','pump-soap','hands-bubbles','sink','faucet','faucet-drip','tooth','teeth','teeth-open','razor','spray-can-sparkles','brush','hand-sparkles','droplet','bottle-droplet','box-tissue','jug-detergent','plug-circle-bolt','water','broom','bucket'],
  'Clothes':['shirt','vest','vest-patches','socks','mitten','hat-cowboy','hat-wizard','hat-hard','glasses','user-tie','person-dress','shoe-prints','bag-shopping','gem','ring','crown','mask','head-side-mask','suitcase','umbrella','scissors','tags','tag','bell-concierge','clothes-hanger'],
  'Home':['house','house-chimney','house-user','couch','bed','lightbulb','fan','door-open','door-closed','key','kitchen-set','blender','mug-hot','utensils','plug','temperature-half','tv','trash','trash-can','box-archive','chair','jar','fire-burner','wind','shop','warehouse','toolbox','hammer','screwdriver-wrench','paint-roller'],
  'Education':['graduation-cap','book','book-open','book-open-reader','book-bookmark','pencil','pen','pen-nib','ruler','calculator','flask','atom','microscope','school','chalkboard','chalkboard-user','language','earth-americas','brain','paperclip','folder','file-lines','highlighter','marker','compass-drafting','square-root-variable','infinity','dna','magnet','scroll','pen-ruler','user-graduate'],
  'Tech':['desktop','laptop','mobile-screen','tablet-screen-button','keyboard','computer-mouse','headphones','microphone','camera','video','wifi','bluetooth','battery-full','plug','floppy-disk','hard-drive','server','code','terminal','robot','gamepad','print','qrcode','sim-card','satellite-dish','memory','microchip','laptop-code','database','cloud','cloud-arrow-up','cloud-arrow-down','power-off','satellite'],
  'Transport':['bicycle','car','bus','train','plane','ship','motorcycle','truck','taxi','van-shuttle','person-biking','person-walking','person-running','rocket','sailboat','gas-pump','road','traffic-light','map-location-dot','route','helicopter','train-subway','tractor','charging-station','car-side','plane-departure','plane-arrival','anchor','compass','map'],
  'Fitness':['dumbbell','heart-pulse','person-running','person-swimming','person-biking','person-hiking','person-skiing','person-walking','weight-scale','basketball','futbol','volleyball','baseball','football','table-tennis-paddle-ball','golf-ball-tee','hockey-puck','medal','trophy','stopwatch','mountain','fire','bolt','child-reaching','person-praying','spa','heart','shoe-prints','hand-fist','mattress-pillow'],
  'Medical':['stethoscope','pills','syringe','bandage','kit-medical','thermometer','lungs','eye','ear-listen','hand-holding-heart','hospital','notes-medical','bed-pulse','head-side-virus','virus','capsules','tablets','vial','prescription-bottle','user-doctor','user-nurse','house-medical','briefcase-medical','x-ray','tooth','brain','heart-circle-plus','wheelchair','crutch','eye-dropper','mask-face','staff-snake'],
  'Food':['utensils','burger','pizza-slice','bowl-rice','bowl-food','mug-hot','mug-saucer','wine-glass','beer-mug-empty','martini-glass','bottle-water','apple-whole','carrot','egg','cookie','cake-candles','ice-cream','bread-slice','cheese','fish','drumstick-bite','bacon','lemon','pepper-hot','candy-cane','cookie-bite','hotdog','shrimp','jar','blender','whiskey-glass','champagne-glasses','wheat-awn','seedling','plate-wheat','cow','kitchen-set','stroopwafel','lemon','pizza-slice'],
  'Nature':['sun','moon','cloud','cloud-sun','cloud-moon','cloud-rain','cloud-showers-heavy','snowflake','bolt','wind','umbrella-beach','rainbow','tree','leaf','seedling','mountain','mountain-sun','water','fire','temperature-high','temperature-low','star','tornado','hurricane','volcano','smog','droplet','clover','feather','meteor','earth-americas','globe','sun-plant-wilt','tents','campground','fire-flame-curved','spa','vihara'],
  'Animals':['paw','dog','cat','horse','fish','dove','spider','bug','hippo','frog','crow','kiwi-bird','dragon','cow','otter','bone','feather','worm','locust','mosquito','bugs','shrimp','hippo','fish-fins','horse-head','kiwi-bird','cat','dog'],
  'Work':['briefcase','building','handshake','chart-line','chart-pie','chart-column','dollar-sign','coins','wallet','credit-card','piggy-bank','receipt','money-bill','sack-dollar','cash-register','calendar-days','clipboard-list','clipboard-check','list-check','bullseye','flag','bell','envelope','phone','comments','comment','paper-plane','address-book','id-card','file-contract','signature','stamp','thumbtack','folder-open','inbox','business-time','user-group','users','award','lightbulb'],
  'Fun':['music','guitar','drum','film','clapperboard','ticket','gamepad','dice','chess','puzzle-piece','palette','paintbrush','camera-retro','masks-theater','wand-magic-sparkles','gift','cake-candles','champagne-glasses','face-smile','face-laugh','heart','ghost','skull','umbrella-beach','hands-praying','dice-d20','chess-knight','microphone-lines','radio','record-vinyl','compact-disc','volume-high','kite','binoculars','martini-glass-citrus','pizza-slice','star','icons','hat-wizard','robot'],
  'Time & rest':['bed','moon','bed-pulse','cloud-moon','stopwatch','clock','hourglass','hourglass-half','hourglass-end','hourglass-start','bell','bell-slash','calendar','calendar-check','calendar-day','calendar-week','calendar-days','sun','star','meteor','user-astronaut','shuttle-space','mattress-pillow','couch','mug-hot','spa','hot-tub-person','face-smile-beam','face-tired','face-sleeping'] 
};
const FA_CAT = {'Bathroom':'shower','Clothes':'shirt','Home':'house','Education':'graduation-cap','Tech':'desktop','Transport':'bicycle','Fitness':'dumbbell','Medical':'stethoscope','Food':'utensils','Nature':'leaf','Animals':'paw','Work':'briefcase','Fun':'masks-theater','Time & rest':'hourglass-half'};
function faMask(n){ return '<i class="fa" style="--u:url(' + FA_URL(n) + ')"></i>'; }
function faTile(n){ const k = 'fa-' + n; return ICONS[k] || (faMask(n) + '<img class="faProbe" src="' + FA_URL(n) + '" alt="" loading="lazy" onerror="this.closest(\'button\').remove()">'); }
function catMarkup(g){ return FA_CAT[g] ? (ICONS['fa-' + FA_CAT[g]] || faMask(FA_CAT[g])) : catIcon(g); }
function drawIconPicker(q){
  q = (q || '').trim().toLowerCase();
  const shown = [], match = (k, g, extra) => !q || (k.replace(/-/g, ' ') + ' ' + (extra || '') + ' ' + g.toLowerCase()).includes(q);
  let out = Object.keys(ICON_GROUPS).map(g => {
    const keys = ICON_GROUPS[g].filter(k => ICONS[k] && match(k, g, ICON_TAGS[k]));
    if (!keys.length) return '';
    shown.push(g);
    return '<div class="ipGroup" id="' + ipId(g) + '"><p class="lbl"><i class="gi">' + catIcon(g) + '</i><span>' + g + '</span></p><div class="ipRow">' + keys.map(k => '<button type="button" data-i="' + k + '" aria-label="' + k.replace(/-/g, ' ') + '" title="' + k.replace(/-/g, ' ') + '">' + ICONS[k] + '</button>').join('') + '</div></div>';
  }).join('');
  out += Object.keys(FA_GROUPS).map(g => {
    const names = Array.from(new Set(FA_GROUPS[g])).filter(n => match(n, g));
    if (!names.length) return '';
    shown.push(g);
    return '<div class="ipGroup" id="' + ipId(g) + '"><p class="lbl"><i class="gi">' + catMarkup(g) + '</i><span>' + g + '</span></p><div class="ipRow">' + names.map(n => '<button type="button" data-fa="' + n + '" aria-label="' + n.replace(/-/g, ' ') + '" title="' + n.replace(/-/g, ' ') + '">' + faTile(n) + '</button>').join('') + '</div></div>';
  }).join('');
  $('#ip_groups').innerHTML = out || '<p class="wn">No icon matches that. You can still paste an emoji below.</p>';
  $('#ip_tabs').innerHTML = shown.map(g => '<button type="button" role="tab" data-g="' + ipId(g) + '" aria-label="' + g + '" title="' + g + '">' + catMarkup(g) + '</button>').join('') + '<button type="button" role="tab" data-g="ip_custom" aria-label="Custom" title="Custom">' + (ICONS.sparkles || '') + '</button>';
  ipSpy();
}
let ipTarget = null;    // who the open icon picker is for: null = the task editor, or a function that takes the chosen icon
function ipSet(v){ if (ipTarget) ipTarget(v); else { $('#e_icon').value = v; updateIconBtn(); } $('#iconPick').close(); }
let pickTok = 0;   // identifies the current icon pick; closing the picker or editor cancels any pick that is still downloading
async function pickFa(n, btn){
  const key = 'fa-' + n, tok = ++pickTok;
  if (!ICONS[key]){
    if (btn) btn.classList.add('loading');
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 8000);
    try{
      if (navigator.onLine === false) throw 0;
      const r = await fetch(FA_URL(n), { signal:ac.signal }); if (!r.ok) throw 0;
      const t = await r.text(), vb = (t.match(/viewBox="([^"]+)"/) || [])[1], ds = [...t.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1]);
      if (!vb || !ds.length) throw 0;
      ICONS[key] = '<svg class="pi" viewBox="' + vb + '">' + ds.map(d => '<path d="' + d + '"/>').join('') + '</svg>';
      try{ const c = JSON.parse(localStorage.getItem('yotei_fa') || '{}'); c[key] = ICONS[key]; localStorage.setItem('yotei_fa', JSON.stringify(c)); }catch{}
    }catch{
      clearTimeout(timer); if (btn) btn.classList.remove('loading');
      if (tok === pickTok) toast('Could not load that icon. Check your connection and try again.');
      return;
    }
    clearTimeout(timer); if (btn) btn.classList.remove('loading');
  }
  if (tok !== pickTok) return;   // the picker or editor was closed (or another icon chosen) while this downloaded: leave the editor alone
  ipSet(key);
}
$('#iconPick').addEventListener('close', () => { pickTok++; ipTarget = null; });
$('#ed').addEventListener('close', () => { pickTok++; });
function ipSpy(){
  const sc = $('#ip_scroll'), tabs = $('#ip_tabs'); if (!sc || !tabs) return;
  const top = sc.getBoundingClientRect().top + 24; let on = null;
  tabs.querySelectorAll('button').forEach(b => { const el = document.getElementById(b.dataset.g); if (el && el.getBoundingClientRect().top <= top) on = b; });
  if (!on) on = tabs.querySelector('button');
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) on = tabs.querySelector('button:last-child') || on;
  tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === on));
  if (on && !tabs.dataset.drag){ const l = on.offsetLeft - (tabs.clientWidth - on.offsetWidth) / 2; if (Math.abs(tabs.scrollLeft - l) > 4) tabs.scrollTo({ left:l, behavior:'smooth' }); }
}
$('#ip_scroll').addEventListener('scroll', () => { if (!ipBusy) ipSpy(); }, { passive:true });
let ipBusy = false;
$('#ip_tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const el = document.getElementById(b.dataset.g), sc = $('#ip_scroll'); if (!el) return;
  ipBusy = true; $('#ip_tabs').querySelectorAll('button').forEach(z => z.classList.toggle('on', z === b));
  sc.scrollTo({ top: sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 4, behavior:'smooth' });
  setTimeout(() => { ipBusy = false; ipSpy(); }, 450);
});
$('#ip_q').addEventListener('input', e => drawIconPicker(e.target.value));
$('#e_iconBtn').addEventListener('click', () => {
  ipTarget = null;
  const v = $('#e_icon').value;
  $('#e_icon_custom').value = (v && !ICONS[v]) ? v : '';
  $('#ip_q').value = ''; drawIconPicker('');
  $('#iconPick').showModal(); $('#ip_scroll').scrollTop = 0; ipSpy();
});
$('#ip_groups').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.fa){ pickFa(b.dataset.fa, b); return; }
  ipSet(b.dataset.i);
});
$('#ip_x').onclick = () => $('#iconPick').close();
$('#ip_ok').onclick = () => {
  ipSet($('#e_icon_custom').value.trim());
};
function curveAvg(pts, from, to){
  const at = h => { for (let i = 0; i < pts.length - 1; i++){ const [h0, v0] = pts[i], [h1, v1] = pts[i + 1]; if (h >= h0 && h <= h1) return v0 + (v1 - v0) * (h - h0) / (h1 - h0); } return pts[pts.length - 1][1]; };
  let t = 0; for (let i = 0; i <= 6; i++) t += at(from + (to - from) * i / 6);
  return Math.round(t / 7 / 5) * 5;
}
const NAP_LISTS = ['home', 'away'];   // not School: you are usually not free to nap there
const napOn = () => NAP_LISTS.every(l => getBlocks(l).some(x => x.id === 'nap-' + l));
function napSet(add){
  NAP_LISTS.forEach(l => {
    const arr = clone(getBlocks(l)).filter(x => x.id !== 'nap-' + l);
    if (add) arr.push({ id:'nap-' + l, t:'Nap', sug:true, d:0, w:'trough', icon:'bed', details:'10 to 20 minutes is plenty. Set an alarm so you do not oversleep.' });
    setBlocks(l, arr);
  });
  render();
  toast(add ? 'Nap suggestion added' : 'Nap suggestion removed');   // no Undo: the sheet is open over it, and its button switches it back
  if ($('#blockInfo').open) openBlockInfo('trough');
}
$('#bi_body').addEventListener('click', e => { const b = e.target.closest('[data-nap]'); if (b) napSet(b.dataset.nap === 'add'); });
function openBlockInfo(k){
  const I = BLOCK_INFO[k], WB = wins(), W = WB[k]; if (!I || !W) return;
  const st = WIN_STYLE[k] || WIN_STYLE.climb1, col = safeCol(st.c) || st.c;
  const bi = $('#blockInfo'); bi.style.setProperty('--tc', col);
  const h = x => x;   // BLOCK_INFO strings are pre-escaped, with <sup> citations only
  const bar = (label, pts, note) => { const v = curveAvg(pts, I.from, I.to); return '<div class="biLv"><span>' + label + '</span><div class="biBar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + v + '" aria-label="' + label + ': ' + v + ' percent"><i style="width:' + v + '%"></i></div></div><p class="biNote">' + h(note) + '</p>'; };
  $('#bi_body').innerHTML =
    '<div class="biHead"><span class="tsIcon" style="--dot:' + col + ';color:' + onColor(col) + '">' + iconMarkup(st.i) + '</span><div class="tsHT"><div class="tsWhen">' + range(wake + W.from, wake + W.to) + '</div><b>' + esc(W.name) + '</b>' + (I.dn !== W.name ? '<div class="tsWhen">' + esc(I.dn) + '</div>' : '') + '</div></div>' +
    '<p class="biSci">' + h(I.sci) + '</p>' +
    (k !== 'sleep' && store.get('chrono', 'normal') === 'mine' && myShift() !== 0 ? '<p class="biNote">Shifted ' + shiftWords(myShift()) + ' from the standard time by your ratings.</p>' : '') +
    '<div class="biFeels"><span>Feels like</span>' + I.feels.map(f => '<i>' + esc(f) + '</i>').join('') + '</div>' +
    '<div class="biCard"><div class="biT">Levels in this window</div>' + bar('Sleep pressure', PRESS_PTS, I.notes[0]) + bar('Circadian drive', CIRC_PTS, I.notes[1]) + '</div>' +
    (k === 'wind' && capsOn() && ((store.get('wins', {}).wind || {}).from === undefined) ? '<p class="biNote">Set by your sleep cap: the 3 hours before ' + clk(CAP.hard) + '.</p>' : '') +
    '<div class="biCard"><div class="biT">Cues for this window</div>' + I.cues.map(c => '<p class="biCue"><b>' + esc(c.l) + '</b>' + h(c.t) + (c.l === 'Caffeine' && capsOn() && (k === 'climb2' || k === 'wmz') ? ' <b>With your bedtime at ' + clk(CAP.hard) + ', aim to finish by ' + clk(CAP.hard - 360) + '.</b>' : '') + '</p>').join('') + '</div>' +
    (k === 'trough' ? '<div class="biCard"><div class="biT">Nap</div><p class="biNote">' + (napOn() ? 'A Nap suggestion is on your Home and Away days. It shows here with no set time.' : 'Add a Nap suggestion (10 to 20 minutes) to your Home and Away days. It shows here with no set time, and you can edit or delete it like any task.') + '</p><button type="button" class="add" data-nap="' + (napOn() ? 'rm' : 'add') + '">' + (napOn() ? 'Remove the nap suggestion' : 'Add a nap suggestion') + '</button></div>' : '') +
    '<details class="biCard"><summary><span class="biT">Common myth</span><em>' + esc(I.myth.hint) + '</em></summary><p>' + h(I.myth.text) + '</p></details>' +
    '<details class="biCard"><summary><span class="biT">If you push against it</span><em>' + esc(I.push.hint) + '</em></summary><p>' + h(I.push.text) + '</p></details>' +
    '<p class="biFoot">Numbers in brackets point to the sources listed in Settings. These are population averages, so your own rhythm may sit earlier or later.</p>';
  $('#bi_body').scrollTop = 0;
  bi.showModal();
}
(function(){ let y0 = null; const h = $('#bi_handle'), bi = $('#blockInfo');
  h.addEventListener('pointerdown', e => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (y0 !== null && e.clientY - y0 > 40){ y0 = null; bi.close(); } });
  ['pointerup', 'pointercancel'].forEach(ev => h.addEventListener(ev, () => { y0 = null; }));
  bi.addEventListener('click', e => { if (e.target === bi) bi.close(); });
})();
(function(){
  const el = $('#srcList'); if (!el) return;
  el.innerHTML = SCI_SRC.map(x => '<li value="' + x.n + '"><span>' + esc(x.what) + '</span>' + (/^https:\/\//.test(x.url) ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title)) + '</li>').join('');
})();
// ============================================================
// TASK DETAIL SHEET — opens on tap, shows name/time + actions
// (Delete / Duplicate / Edit). Deliberately excludes Details —
// keep it lean, see the phase history for why.
// ============================================================
let sheetCtx = null;
Object.assign(ICONS, { 'check-circle':'<svg class="pi" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z"/></svg>' });
const tile = (id, ic, label) => { $('#' + id).innerHTML = ICONS[ic] + '<span>' + label + '</span>'; };
function openTaskSheet(l, id){
  const { rows } = schedule();
  const r = rows.find(x => sameId(x.id, id));
  if (!r) return;
  sheetCtx = { l: resolveList(l, id), id };
  const st = WIN_STYLE[r.w] || WIN_STYLE.climb1, col = safeCol(r.color) || st.c;
  const cut = r.use === 0 && !r.sug && r.fixed === undefined;
  const sh = $('#taskSheet'); sh.style.setProperty('--tc', col); sh.style.setProperty('--tcon', onColor(col));
  $('#ts_icon').innerHTML = iconMarkup(r.icon || guessIcon(r.t) || st.i);
  $('#ts_icon').style.setProperty('--dot', col); $('#ts_icon').style.color = onColor(col);
  $('#ts_title').innerHTML = esc(r.t) + (l !== 'oo' ? ICONS['arrows-clockwise'] : '');
  const dt = parseDay(viewDate).toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const dur = m => m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  $('#ts_time').textContent = dt + ' \u00b7 ' + (cut ? 'Skipped today' : r.sug ? 'Suggestion' : range(r.start, r.end) + ' (' + dur(r.use) + ')');
  const dEl = $('#ts_details'); dEl.textContent = r.details || 'No details yet'; dEl.className = r.details ? '' : 'none';
  const ins = taskInsight(id); $('#ts_insight').textContent = ins; $('#ts_insight').hidden = !ins;
  const isDone = done.ids.includes(r.id), nt = getNote(id);
  tile('ts_del', 'trash', 'Delete'); tile('ts_dup', 'files', 'Duplicate');
  tile('ts_done', 'check-circle', isDone ? 'Not done' : 'Complete'); $('#ts_done').hidden = cut || r.sug;
  tile('ts_noteb', 'note', nt ? 'Edit note' : 'Add note');
  tile('ts_timer', 'timer', 'Timer'); $('#ts_timer').hidden = !(r.use > 0) || r.sug || viewDate !== todayStr() || snapMode();
  tile('ts_move', 'paper-plane', 'Move');
  $('#ts_edit').innerHTML = ICONS['pencil-line'] + 'Edit task';
  sh.showModal(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
(function(){ let y0 = null; const h = $('#ts_handle'), sh = $('#taskSheet');
  h.addEventListener('pointerdown', e => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (y0 !== null && e.clientY - y0 > 40){ y0 = null; sh.close(); } });
  ['pointerup', 'pointercancel'].forEach(ev => h.addEventListener(ev, () => { y0 = null; }));
  sh.addEventListener('click', e => { if (e.target === sh) sh.close(); });
})();
$('#ts_done').onclick = () => {
  const k = sheetCtx.id, i = done.ids.indexOf(k);
  if (i === -1) done.ids.push(k); else done.ids.splice(i, 1);
  saveDay(); $('#taskSheet').close(); render(); if (i === -1) offerTickAll(k);
};
$('#ts_edit').onclick = () => { $('#taskSheet').close(); openEd(sheetCtx.l, sheetCtx.id); };
$('#ts_dup').onclick = () => {
  const r = schedule().rows.find(x => sameId(x.id, sheetCtx.id)); if (!r) return;
  $('#taskSheet').close();
  openEd('oo', null, r.w); cur.addScope = true; drawEdTypes();
  $('#e_t').value = r.t;
  $('#e_k').value = r.sug ? 'sug' : ['core', 'flex', 'opt'].includes(r.p) ? r.p : r.p === 'open' ? 'open' : 'fixedlen';
  $('#e_d').value = r.d !== undefined ? r.d : r.use; $('#e_m').value = r.m ?? ''; highlightChip();
  $('#e_icon').value = r.icon || ''; updateIconBtn();
  $('#e_color').value = r.color || ''; drawColorRow('e'); setEdAccent();
  $('#e_details').value = r.details || ''; edSteps.set(r.steps);
  endDriven = false; $('#e_s').value = ''; $('#e_e').value = ''; $('#e_fx').checked = false; refreshWinLock(); applyKindUI();
};
// ============================================================
// SUBTASK SHEET — opens from the small icon next to a task's
// subtask count. Checklist only, no Delete/Duplicate/Edit here.
// ============================================================
// ---- subtask rows (task editor and to-do editor): add one at a time, drag to reorder, remove with the cross ----
function stepRow(v){
  const o = typeof v === 'string' ? { t:v } : (v || {});
  const d = document.createElement('div'); d.className = 'sdRow'; if (o.d) d.dataset.d = '1';
  d.innerHTML = '<span class="sdH" aria-label="Drag to reorder" title="Drag to reorder">&#8942;&#8942;</span><button type="button" class="sdC" aria-pressed="' + (o.d ? 'true' : 'false') + '" aria-label="Mark subtask done"></button><input class="sdIn" maxlength="120" placeholder="Subtask" aria-label="Subtask"><button type="button" class="sdX" aria-label="Remove subtask">&times;</button>';
  d.querySelector('input').value = o.t || ''; return d;
}
function makeSteps(boxSel, nSel, addSel, fmtN){
  const box = $(boxSel);
  const get = () => [...box.querySelectorAll('.sdRow')].map(r => ({ t:r.querySelector('.sdIn').value.trim(), d:r.dataset.d === '1' })).filter(s => s.t);
  const count = () => { const a = get(), n = a.length; $(nSel).textContent = fmtN ? fmtN(n, a.filter(z => z.d).length) : n ? '(' + n + ')' : ''; };
  const set = a => { box.innerHTML = ''; (a || []).forEach(v => box.appendChild(stepRow(v))); count(); };
  $(addSel).onclick = () => { const r = stepRow(''); box.appendChild(r); r.querySelector('input').focus(); };
  box.addEventListener('input', count);
  box.addEventListener('click', e => {
    const x = e.target.closest('.sdX'); if (x){ x.closest('.sdRow').remove(); count(); return; }
    const c = e.target.closest('.sdC'); if (c){ const r = c.closest('.sdRow'), on = r.dataset.d !== '1'; if (on) r.dataset.d = '1'; else delete r.dataset.d; c.setAttribute('aria-pressed', on ? 'true' : 'false'); count(); }
  });
  box.addEventListener('keydown', e => {
    const inp = e.target.closest('.sdIn'); if (!inp) return;
    const row = inp.closest('.sdRow');
    if (e.key === 'Enter'){ e.preventDefault(); if (!inp.value.trim()) return; const r = stepRow(''); row.after(r); r.querySelector('input').focus(); }
    else if (e.key === 'Backspace' && !inp.value){ e.preventDefault(); const p = row.previousElementSibling; row.remove(); count(); if (p) p.querySelector('input').focus(); }
  });
  let row = null;
  box.addEventListener('pointerdown', e => { const h = e.target.closest('.sdH'); if (!h) return; row = h.closest('.sdRow'); row.classList.add('drag'); h.setPointerCapture(e.pointerId); e.preventDefault(); });
  box.addEventListener('pointermove', e => {
    if (!row) return;
    const others = [...box.children].filter(r => r !== row); let before = null;
    for (const r of others){ const b = r.getBoundingClientRect(); if (e.clientY < b.top + b.height / 2){ before = r; break; } }
    if (before !== row.nextElementSibling) box.insertBefore(row, before);
  });
  const end = () => { if (row){ row.classList.remove('drag'); row = null; } };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  return { get, set };
}
const edSteps = makeSteps('#e_steps', '#e_stepsN', '#e_stepAdd');
const tdeSteps = makeSteps('#tde_steps', '#tde_stepsN', '#tde_stepAdd', (n, d) => n ? d + ' of ' + n : '');

let stepsSheetId = null;
function tickAllSteps(id, on = true){
  const r = schedule().rows.find(x => sameId(x.id, id)); if (!r || !(r.steps || []).length) return;
  r.steps.forEach((z, i) => { const k = id + '#' + i, j = done.ids.indexOf(k); if (on && j === -1) done.ids.push(k); if (!on && j !== -1) done.ids.splice(j, 1); });
  const pi = done.ids.indexOf(id); if (on && pi === -1) done.ids.push(id); if (!on && pi !== -1) done.ids.splice(pi, 1);
  saveDay(); render();
}
function offerTickAll(id){
  const r = schedule().rows.find(x => sameId(x.id, id)); if (!r) return;
  const n = (r.steps || []).filter((z, i) => !done.ids.includes(id + '#' + i)).length;
  if (n) toast(n === 1 ? 'Tick the subtask too?' : 'Tick all ' + n + ' subtasks too?', 'Tick all', () => tickAllSteps(id));
}
function ssRefresh(){
  const r = schedule().rows.find(x => sameId(x.id, stepsSheetId)); if (!r) return;
  $('#ss_list').innerHTML = stepsRowsHtml(r);
  const all = (r.steps || []).every((z, i) => done.ids.includes(r.id + '#' + i));
  $('#ss_all').textContent = all ? 'Untick all' : 'Tick all';
}
function stepsRowsHtml(r){
  const dot = r.color || (WIN_STYLE[r.w] || WIN_STYLE.climb1).c;
  return (r.steps || []).map((z, i) => {
    const k = r.id + '#' + i, dn = done.ids.includes(k);
    return '<button class="stp' + (dn ? ' done' : '') + '" data-k="' + k + '" data-b="' + r.id + '" data-n="' + r.steps.length + '" style="--dot:' + dot + '"><span class="ssCheck"></span><span>' + esc(z) + '</span></button>';
  }).join('');
}
function openStepsSheet(id){
  const { rows } = schedule(), r = rows.find(x => sameId(x.id, id));
  if (!r || !(r.steps || []).length) return;
  stepsSheetId = id;
  $('#ss_title').textContent = r.t;
  ssRefresh();
  $('#stepsSheet').showModal();
}
$('#ss_close').onclick = () => $('#stepsSheet').close();
$('#ss_all').onclick = () => { const on = $('#ss_all').textContent === 'Tick all'; tickAllSteps(stepsSheetId, on); ssRefresh(); };
$('#ss_list').addEventListener('click', e => {
  const st = e.target.closest('.stp'); if (!st) return;
  const k = st.dataset.k, i = done.ids.indexOf(k);
  if (i === -1) done.ids.push(k); else done.ids.splice(i, 1);
  const b = st.dataset.b, all = Array.from({ length:+st.dataset.n }, (_, j) => done.ids.includes(b + '#' + j)).every(Boolean), bi = done.ids.indexOf(b);
  if (all && bi === -1) done.ids.push(b); else if (!all && bi !== -1) done.ids.splice(bi, 1);
  saveDay();
  render();
  ssRefresh();
});
$('#e_presets').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $('#e_d').value = b.dataset.m; highlightChip(); if (endDriven) startFromEnd(); else syncEnd();
});
$('#e_d').addEventListener('input', () => { highlightChip(); if (endDriven){ if (parseInt($('#e_d').value) > 0) startFromEnd(); } else syncEnd(); });
$('#e_s').addEventListener('input', () => {
  const s = $('#e_s').value; endDriven = false;
  if (s){ if ($('#e_k').value === 'sug') setKind('fixedlen'); syncEnd(); syncWinSel(); }
  else { $('#e_e').value = ''; $('#e_fx').checked = false; }
  refreshWinLock();
});
$('#e_e').addEventListener('input', () => {
  const s = $('#e_s').value, e = $('#e_e').value;
  if (!e){ if (endDriven){ $('#e_s').value = ''; $('#e_fx').checked = false; endDriven = false; refreshWinLock(); } return; }
  if (!s || endDriven){                       // End first (or End changed again): count back from it using the length
    if (!startFromEnd()){ $('#e_e').value = ''; if (endDriven){ $('#e_s').value = ''; endDriven = false; refreshWinLock(); } }
    return;
  }
  const [h, mi] = s.split(':').map(Number), [h2, m2] = e.split(':').map(Number), d = h2*60 + m2 - (h*60 + mi);
  if (d > 0){ $('#e_d').value = d; highlightChip(); }
  else { edErr('End time has to be after the start time.'); syncEnd(); }
});
function syncWinSel(){
  const f = $('#e_s').value; if (!f || $('#e_wrap').style.display === 'none') return;
  const [h, mi] = f.split(':').map(Number); $('#e_w').value = winFor(h*60 + mi); drawEdTypes();
}
$('#e_k').addEventListener('change', () => {
  const k = $('#e_k').value;
  if (k === 'sug'){ endDriven = false; $('#e_s').value = ''; $('#e_e').value = ''; $('#e_fx').checked = false; }
  if (k !== 'sug' && !(parseInt($('#e_d').value) > 0)){ $('#e_d').value = 20; highlightChip(); }
  if (['core', 'flex', 'opt'].includes(k) && $('#e_m').value === '') $('#e_m').value = $('#e_d').value;
  applyKindUI(); syncEnd(); refreshWinLock();
});
$('#e_fx').addEventListener('change', () => { if ($('#e_fx').checked && !$('#e_s').value) edErr('Pick a Start time for a fixed task.'); });
$('#e_days').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const i = +b.dataset.i;
  edDays = edDays.includes(i) ? edDays.filter(z => z !== i) : edDays.concat(i); drawDays();
});
$('#e_x').onclick = () => $('#ed').close();
$('#ed').addEventListener('input', () => { $('#e_err').hidden = true; }, true);   // capture phase: clear the old message first, so an error raised by this very input stays visible
$('#e_up').onclick = () => moveBlock(-1);
$('#e_dn').onclick = () => moveBlock(1);
$('#e_ok').onclick = () => {
  const t = $('#e_t').value.trim();
  if (!t){ edErr('Give the task a name first.'); return; }
  if (cur.l === 'win'){ saveWinBlock(t); return; }
  { let s = $('#e_s').value; const e = $('#e_e').value;
    if (e && !s){ if (!startFromEnd()) return; s = $('#e_s').value; }
    if (s && e){ const [h, mi] = s.split(':').map(Number), [h2, m2] = e.split(':').map(Number); if (h2*60 + m2 <= h*60 + mi){ edErr('End time has to be after the start time.'); return; } }
  }
  let k = $('#e_k').value;
  if (k !== 'sug' && !(parseInt($('#e_d').value) > 0)){ edErr('Set how long it takes, in minutes.'); return; }
  const arr = clone(getBlocks(cur.l)), old0 = arr.find(x => sameId(x.id, cur.id)), old = effBlock(cur.l, old0);
  const b = { id: old ? old.id : 'u' + Date.now().toString(36), t };
  if (old){ const FORM = ['id','t','d','m','p','sug','fixed','at','details','color','icon','steps','days','w']; Object.keys(old).forEach(z => { if (!FORM.includes(z)) b[z] = old[z]; }); }
  if (cur.l === 'oo') b.w = $('#e_w').value || 'climb1'; else if (old && old.w) b.w = old.w; else if (cur.l !== 'pre' && cur.l !== 'night') b.w = cur.w || 'climb1';
  const details = $('#e_details').value.trim(); if (details) b.details = details;
  const color = $('#e_color').value.trim(); if (color) b.color = color;
  const icon = $('#e_icon').value.trim(); if (icon) b.icon = icon;
  const steps = edSteps.get().map(s => s.t); if (steps.length) b.steps = steps;
  if (cur.fromInbox) b.src = 'inbox'; else if (cur.fromTodo) b.src = 'todo';     // shown as a small tag on the timeline
  if (cur.l !== 'oo'){ if (!edDays.length){ edErr('Pick at least one day.'); return; } if (edDays.length < 7) b.days = edDays.slice().sort(); }
  if (cur.l !== 'oo'){
    const f0 = $('#e_from').value, t0 = $('#e_to').value;
    if (f0 && t0 && t0 < f0){ edErr('The end date is before the start date.'); return; }
    if (f0) b.from = f0; else delete b.from;
    if (t0) b.to = t0; else delete b.to;
  }
  const d = Math.max(0, parseInt($('#e_d').value) || 0), m = parseInt($('#e_m').value);
  if (k === 'sug'){ b.sug = true; b.d = 0; }
  else {
    b.d = d;
    if (k === 'open') b.p = 'open';
    else if (k !== 'fixedlen'){ b.p = k; b.m = Math.min(d, isNaN(m) ? d : m); }
    const f = $('#e_s').value;
    if ($('#e_fx').checked && !f){ edErr('Pick a Start time for a fixed task, or turn Fixed time off.'); return; }
    if (f){
      const [h, mi] = f.split(':').map(Number), tm0 = h*60 + mi;
      if ($('#e_fx').checked) b.fixed = tm0; else b.at = tm0;
      if (cur.l !== 'pre' && cur.l !== 'night') b.w = winFor(tm0);
      else { const need = cur.l === 'pre' ? 'sleep' : 'wind', got = winFor(tm0); if (got !== need){ edErr('That time falls in ' + wins()[got].name + ', not ' + wins()[need].name + '. Add it from that window instead.'); return; } }
    }
  }
  const wantTypes = WIN_LISTS.includes(cur.l) || (cur.l === 'oo' && cur.addScope && cur.isNew && b.w !== 'sleep' && b.w !== 'wind');
  const T = wantTypes ? (edTypes ? edTypes.slice() : [WIN_LISTS.includes(cur.l) ? cur.l : (typeOf(b.w) || 'home')]) : undefined;
  const typesChanged = !!(old && T && edTypesOrig && (T.length !== edTypesOrig.length || T.some(x => !edTypesOrig.includes(x))));
  if (cur.l === 'oo' && cur.addScope && !old && !cur.fromInbox){
    const w = b.w, l = w === 'sleep' ? 'pre' : w === 'wind' ? 'night' : (typeOf(w) || 'home');
    askScope('add', { l, id:b.id, b, old:null, w, types:T }); return;
  }
  if (cur.l !== 'oo'){
    if (old && !Object.keys(diffBlock(old, b)).length && !typesChanged){ $('#ed').close(); return; }
    askScope(old ? 'edit' : 'add', { l:cur.l, id:b.id, b, old, w:cur.w, types:T }); return;
  }
  needLive();
  if (old0) arr[arr.indexOf(old0)] = b; else arr.push(b);
  if (cur.fromInbox) store.set('inbox', store.get('inbox', []).filter(x => x.id !== cur.fromInbox));
  if (cur.fromTodo){
    const tl = store.get('todos', []), src = tl.find(x => x.id === cur.fromTodo);
    if (src && src.rep && src.due){ tdAdvance(src); store.set('todos', tl); }      // a repeating to-do stays and moves to its next date
    else store.set('todos', tl.filter(x => x.id !== cur.fromTodo));
    drawTodo();
  }
  setBlocks(cur.l, arr); $('#ed').close(); render();
};
$('#e_x2').onclick = () => $('#e_x').click();
$('#settingsBtn').addEventListener('click', () => setTab('settings'));
$('#editDone').addEventListener('click', () => $('#editToggle').click());   // quick way out of editing mode
$('#editToggle').addEventListener('click', () => {
  editing = !editing;
  $('#settingsBtn').classList.toggle('on', editing);
  document.body.classList.toggle('editing', editing);
  { const t = editing ? 'Turn off editing' : 'Turn on editing', rb = $('#editToggle').querySelector('.rbT'); if (rb) rb.textContent = t; else $('#editToggle').textContent = t; }
  if (editing) setTab('home');
  render();
});
// ============================================================
// HISTORY & TRENDS TABS
// ============================================================
function historyDayInner(h){
  const WB = wins(), rs = h.rows || [];
  const tp = h.types ? Object.keys(h.types).map(k => esc(WB[k] ? WB[k].name : k) + ': ' + (MODE_LABEL[h.types[k]] || '')).join(', ') : '';
  const groups = Object.keys(WB).map(k => {
    const g = rs.filter(r => r.w === k && (r.u > 0 || r.done));
    return g.length ? '<p class="hd">' + esc(WB[k].name) + '</p>' + g.map(r => '<p class="hl' + (r.done ? ' ok' : '') + '"><span class="ht">' + fmt(r.s).join(' ') + '</span>' + esc(r.t) + (r.n ? '<br><span class="ht">Note</span>' + esc(r.n) : '') + '</p>').join('') : '';
  }).join('');
  return (tp ? '<p class="wn">' + tp + '</p>' : '') + (h.note ? '<p class="hl">Note: ' + esc(h.note) + '</p>' : '') + groups;
}
// ---- new History tab: data in, HTML out (history.js does the work) ----
const HV_ART = '<svg class="ibArt" viewBox="0 0 96 80" aria-hidden="true"><rect x="26" y="4" width="46" height="44" rx="7" style="fill:var(--card2)"/><rect x="14" y="12" width="68" height="62" rx="9" style="fill:var(--card);stroke:var(--line)"/><rect x="24" y="24" width="12" height="12" rx="3" style="fill:var(--accent);opacity:.3"/><rect x="42" y="24" width="12" height="12" rx="3" style="fill:var(--accent);opacity:.55"/><rect x="60" y="24" width="12" height="12" rx="3" style="fill:var(--accent)"/><rect x="24" y="42" width="12" height="12" rx="3" style="fill:var(--accent);opacity:.8"/><rect x="42" y="42" width="12" height="12" rx="3" style="fill:var(--card2)"/><rect x="60" y="42" width="12" height="12" rx="3" style="fill:var(--card2)"/><path d="M24 64h48" stroke-width="4" stroke-linecap="round" style="stroke:var(--card2)"/></svg>';
const histUI = { hide: new Set(store.get('histHide', [])), kind: ['week', 'month', 'all'].includes(store.get('histRange', 'week')) ? store.get('histRange', 'week') : 'week', off: 0, open: new Set() };
function drawHistory(){
  const WB = wins(), ts = todayStr(), H = { ...store.get('hist', {}) }, t = remRowsFor(ts);
  H[ts] = { rows: t.rows.map(r => ({ w:r.w, id:r.id, t:r.t, s:r.start, e:r.end, u:r.use, sug:!!r.sug, done:t.done.includes(r.id), n:'' })) };      // today comes from the live schedule
  const names = {}; Object.keys(WB).forEach(k => { names[k] = WB[k].name; });
  const out = historyHtml({ H, today:ts, kind:histUI.kind, off:histUI.off, names, energy:store.get('energy', []), chrono:store.get('chrono', 'normal'),
    peakMid:(WIN.peak.from + WIN.peak.to) / 2, rhySug:rhyCard(), eChart:eChartData(), enCol:EN_COL, todoLog:store.get('todoLog', []), hide:histUI.hide, ic:{ art:HV_ART, cal:IN_CAL, chk:IN_CHK, check:IN_CHECK }, open:histUI.open, dayInner:historyDayInner, fmtTime:m => fmt(m).join(' ') });
  histUI.off = out.range.off;
  $('#trends').innerHTML = out.trends; $('#histbox').innerHTML = out.list;
}
$('#histbox').addEventListener('toggle', e => { const d = e.target; if (d && d.matches && d.matches('details[data-d]')){ if (d.open) histUI.open.add(d.dataset.d); else histUI.open.delete(d.dataset.d); } }, true);
function drawNav(){
  const d = parseDay(viewDate);
  $('#date').innerHTML = '<b>' + d.toLocaleDateString(undefined, { weekday:'long' }) + '</b><span class="dacc">' + d.toLocaleDateString(undefined, { month:'long', day:'numeric', year:'numeric' }) + '</span>';
  const base = mondayOf(viewDate), todayDS = todayStr();
  let strip = '', anyDots = false;
  for (let i = 0; i < 7; i++){
    const wd = new Date(base); wd.setDate(base.getDate() + i);
    const ds = isoLocal(wd), sel = ds === viewDate, isToday = ds === todayDS;
    const mt = dayMeta(ds);
    strip += '<button class="wd' + (sel ? ' on' : '') + (isToday ? ' today' : '') + (mt.past ? ' past' : '') + '" data-d="' + ds + '" aria-label="' + esc(wd.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })) + (mt.away ? ', away day' : '') + (mt.note ? ', has a note' : '') + '"><span class="wdn">' + wd.toLocaleDateString(undefined, { weekday:'short' }) + '</span><span class="wdd">' + wd.getDate() + (mt.away ? '<b class="wdb away">' + ICONS.suitcase + '</b>' : mt.note ? '<b class="wdb note"></b>' : '') + '</span><span class="wdots">' + dayColors(ds).map(d => { anyDots = true; return '<i style="--c:' + d.c + '">' + (ICONS[d.i] || '') + '</i>'; }).join('') + '</span></button>';
  }
  const chev = d => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  strip = '<button type="button" class="wsNav" data-nav="-1" aria-label="Previous week">' + chev('M15 6l-6 6 6 6') + '</button>' + strip + '<button type="button" class="wsNav" data-nav="1" aria-label="Next week">' + chev('M9 6l6 6-6 6') + '</button>';
  $('#weekstrip').innerHTML = strip; $('#weekstrip').classList.toggle('nodots', !anyDots);      // no empty row of dots when nothing is planned
  $('#hdrToday').hidden = viewDate === todayStr();
  $('#liveBtn').hidden = !snapMode();
  drawHdr();
}
let lastSig = '';
function saveHist(){
  const tn = store.get('taskNotes', {});
  const snap = { dow:dowOf(day.date), wake, types:day.types, note:day.note || '', rows:schedule().rows.map(r => ({ w:r.w, id:r.id, t:r.t, md:r.md || null, s:r.start, e:r.end, u:r.use, sug:!!r.sug, done:done.ids.includes(r.id), n:tn[day.date + '_' + r.id] || '' })) };
  const sig = day.date + JSON.stringify(snap);
  if (sig === lastSig) return;
  lastSig = sig;
  const h = store.get('hist', {});
  if (!snap.rows.some(r => r.u > 0 && !r.sug)){ if (h[day.date]){ delete h[day.date]; store.set('hist', h); } return; }
  h[day.date] = snap;
  const keys = Object.keys(h).sort(cmpDay);
  while (keys.length > 90) delete h[keys.shift()];
  store.set('hist', h);
  const oldest = keys[0], nm = store.get('taskNotes', {});
  let ch = false;
  for (const k in nm){ if (k.split('_')[0] < oldest){ delete nm[k]; ch = true; } }
  if (ch) store.set('taskNotes', nm);
}
// ============================================================
// MAIN RENDER LOOP — render() picks today vs. another date,
// draw() builds today's live interactive timeline.
// ============================================================
function render(){
  remSoon(); if (document.body.dataset.setpage === 'sched') drawDated();
  applyWinColors();
  drawNav();
  if (document.activeElement !== $('#dnote')) $('#dnote').value = day.note || '';
  drawInbox(); drawTodo(); drawEnergy(); drawEmpty();
  document.body.classList.toggle('snap', snapMode());
  draw();
  if (document.body.dataset.tab === 'history') drawHistory();      // the History tab only rebuilds while you are looking at it, and always when you open it
  drawCaps(); drawLeave(); drawRhythm();
  if (viewDate === todayStr()) saveHist();
}
function draw(){
  const w = wake, isToday = viewDate === todayStr(), NM = isToday ? nowM() : (viewDate < todayStr() ? 1e4 : -1);
  $('#wake').value = toVal(w);
  const { rows, msg, tone } = schedule();
  let capMsg = '', capTone = 'warn';
  if (capsOn() && isToday && (NM >= CAP.hard || NM < wake)){ capMsg = 'Past your hard sleep cap (' + fmt(CAP.hard).join(' ') + '). Lights out. After it, only core tasks stay on the schedule.'; capTone = 'bad'; }
  else if (capsOn() && isToday && NM >= CAP.soft) capMsg = 'Past your soft sleep cap (' + fmt(CAP.soft).join(' ') + '). Wrap up. Optional tasks after it are skipped.';
  const m = $('#msg'); m.textContent = capMsg || msg; m.className = 'msg ' + (capMsg ? capTone : tone);
  const live = rows.filter(r => r.use > 0);
  const n = live.filter(r => done.ids.includes(r.id)).length;
  $('#prog').innerHTML = live.length ? '<span class="pgBar"><i style="width:' + Math.round(n / live.length * 100) + '%"></i></span><span class="pgT">' + n + ' of ' + live.length + ' done</span>' : '';
  updSum();
  const rowHtml = (r, prev) => {
    const cut = r.use === 0 && !r.sug && r.fixed === undefined, dn = done.ids.includes(r.id);
    let tag = '';
    const isNow = r.use > 0 && !r.sug && NM >= r.start && NM < r.end;
    const winB = WIN[r.w] ? wins()[r.w] : null;
    const overflow = winB && r.use > 0 && !r.sug && r.start <= w + winB.to && r.end > w + winB.to;
    const sw = (prev && prev.md && r.md !== prev.md && MODE_NAME[r.md] ? '<span class="tag warn">switched to ' + MODE_NAME[r.md] + '</span>' : '') + (r.src ? '<span class="tag">from ' + (r.src === 'todo' ? 'To-do' : 'Inbox') + '</span>' : '') + (r.fixed !== undefined ? '<span class="tag">fixed time</span>' : '') + (overflow ? '<span class="tag warn">runs past window end</span>' : '');
    if (cut) tag = '<span class="tag bad">' + (r.capCut ? 'past sleep cap' : 'cut today') + '</span>';
    else if (r.m !== undefined && r.use < r.d) tag = '<span class="tag warn">' + (r.use - r.d) + ' min</span>';
    else if (r.p === 'buf') tag = '<span class="tag ok">buffer</span>';
    const st = WIN_STYLE[r.w] || WIN_STYLE.climb1;
    const dotColor = safeCol(r.color) || st.c;
    const h = dotHeight(r.use);
    const frac = (r.sug || r.use === 0) ? 0 : fracFor(r, NM);
    const dotIcon = (isNow && frac > 0 && frac < 1 && ICONS[r.icon || guessIcon(r.t) || st.i]) ? waveHtml(r.icon || guessIcon(r.t) || st.i, dotColor, frac, h) : dotFillHtml(r.icon || guessIcon(r.t) || st.i, dotColor, frac, h);
    const dotStyle = 'width:' + DOT_W + 'px;height:' + h + 'px;border-radius:' + (DOT_W / 2) + 'px;background:' + dotBg(dotColor, frac) + ';--c:' + dotColor + ';--g:' + (frac > 0 ? 1 : 0);
    const nDone = (r.steps || []).filter((z, i) => done.ids.includes(r.id + '#' + i)).length;
    const stepBadge = r.steps && r.steps.length ? '<span class="stepsBtn chipS" role="button" tabindex="0" data-sid="' + r.id + '" aria-label="Subtasks"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/></svg>' + nDone + '/' + r.steps.length + '</span>' : '';
    const timeLbl = (cut || r.sug) ? '' : fmt(r.start).join(' ');
    const check = r.sug ? '' : '<span class="tlcheck"></span>';
    const timed = r.use > 0 && !r.sug && !cut;
    let pq = null; for (let q = rows.indexOf(r) - 1; q >= 0; q--){ if (rows[q].use > 0 && !rows[q].sug){ pq = rows[q]; break; } }
    const col1 = '<span class="tlcol1">' + (timed && (!pq || pq.end < r.start) && !(isNow && frac * h < 22) ? '<span class="tltime">' + fmt(r.start).join(' ') + '</span>' : '') + (timed && !(isNow && (1 - frac) * h < 22) ? '<span class="tlend">' + fmt(r.end).join(' ') + '</span>' : '') + (isNow ? '<span class="tlnow" style="top:' + Math.max(16, Math.min(80, Math.round(frac * 100))) + '%">' + fmt(NM).join(' ') + '</span>' : '') + '</span>';
    const dur = m => m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    const metaTxt = cut ? 'Skipped' : r.sug ? 'Suggestion' : r.use > 0 ? (isNow ? (r.end - NM) + 'm remaining' : range(r.start, r.end) + ' (' + dur(r.use) + ')') : fmt(r.start).join(' ');
    const noteIc = getNote(r.id) ? '<span class="noteMark" aria-label="Has a note"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg></span>' : '';
    const chips = (stepBadge || noteIc) ? '<span class="tlchips">' + stepBadge + noteIc + '</span>' : '';
    return '<div class="blk" data-c="' + dotColor + '" data-f="' + frac.toFixed(3) + '"><button class="tlrow' + (dn ? ' done' : '') + (isNow ? ' now' : '') + (cut ? ' cut' : '') + (r.sug ? ' sug' : '') + '" style="--dot:' + dotColor + ';--h:' + h + 'px" data-id="' + r.id + '" data-l="' + (r.post ? r.md : 'pre') + '" data-locked="' + ((cut || r.sug) ? 1 : 0) + '" aria-label="' + esc(r.t) + (cut ? ', skipped' : r.sug ? ', suggestion' : dn ? ', done' : ', not done') + '">' + col1 + '<span class="tldot" style="' + dotStyle + '">' + dotIcon + '</span><span class="tlbody"><span class="time">' + metaTxt + tag + sw + '</span><span class="ttl">' + esc(r.t) + (editing && r.p !== 'buf' ? '<span class="dragH" aria-label="Drag to move" title="Drag to move">&#8942;&#8942;</span>' : '') + '</span>' + chips + '</span>' + check + '</button>' + noteHtml(r) + '</div>';
  };
  const MIN_GAP = 5, canAdd = !snapMode();      // gaps shorter than 5 minutes are not worth showing
  function gapEl(from, to, l, w){                // a free stretch of time: broken line + "free" label + add button
    const mins = to - from; if (mins < MIN_GAP) return '';
    const h = Math.floor(mins / 60), m = mins % 60, dur = ((h ? h + 'h ' : '') + (m || !h ? m + 'm' : '')).trim();
    return '<div class="gap"><span class="gaptxt">' + dur + ' free</span>' + (canAdd ? '<button class="add" data-l="' + l + '" data-w="' + w + '" data-s="' + from + '">+ Add task</button>' : '') + '</div>';
  }
  function gapRows(rs){
    let out = '';
    for (let i = 0; i < rs.length; i++){
      out += rowHtml(rs[i], rs[i - 1]);
      const cur = rs[i], next = rs[i + 1];
      if (cur.use > 0 && !cur.sug && next && next.use > 0 && !next.sug && next.start > cur.end) out += gapEl(cur.end, next.start, cur.md || 'pre', cur.w);
    }
    return out;
  }
  function noteHtml(r){
    if (noteEditing === r.id && !editing) return '<div class="noteEdit"><textarea class="ntxt">' + esc(getNote(r.id)) + '</textarea><div class="ea"><button class="ncancel">Cancel</button><button class="nsave" data-nid="' + r.id + '">Save</button></div></div>';
    const n = getNote(r.id);
    return (n && shownNotes.has(noteKey(r.id)) ? '<div class="noteShow open" data-nid="' + r.id + '" title="Tap to edit">' + esc(n) + '</div>' : '');
  }
  const WB = wins();
  const winSection = k => {
    const t = typeOf(k), rs = rows.filter(r => r.w === k), st = WIN_STYLE[k];
    const nominalEnd = wake + WB[k].to, lastTaskEnd = rs.length ? Math.max(...rs.map(r => r.end)) : nominalEnd;
    const isNowW = NM >= wake + WB[k].from && NM < Math.max(nominalEnd, lastTaskEnd), started = NM >= wake + WB[k].from;
    const runHtml = ((k === 'sleep' || k === 'wind') && isToday && rs.some(r => r.use > 0 && !r.sug && !done.ids.includes(r.id))) ? '<button type="button" class="add runBtn" data-run="' + k + '" aria-label="Start ' + esc(WB[k].name.toLowerCase()) + '"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>Start</button>' : '';
    const chipHtml = runHtml || ((k !== 'sleep' && k !== 'wind') ? '<button type="button" class="mchip" data-chip="' + k + '" aria-expanded="' + (pickOpen === k) + '" aria-label="Where you are during ' + esc(WB[k].name) + ': ' + esc(MODE_LABEL[t] || 'not set') + '">' + esc(MODE_LABEL[t] || 'Set') + '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>' : '');
    let html = '<div class="tlhead" data-k="' + k + '" data-c="' + st.c + '" data-f="' + (started ? 1 : 0) + '" style="--dot:' + st.c + '"><span class="tlspacer"></span><span class="tldot" style="color:' + onColor(st.c) + '">' + iconMarkup(st.i) + '</span><div class="tlheadtext"><b>' + esc(WB[k].name) + '</b><span class="tlmeta">' + (isNowW ? 'Now, ' : '') + range(wake + WB[k].from, wake + WB[k].to) + '</span></div>' + chipHtml + '</div>';
    if (k !== 'sleep' && k !== 'wind'){
      const bypassColor = started ? st.c : 'var(--graydot)';
      const modeKeys = Object.keys(MODE_LABEL).filter(m => !(k === 'wmz' && m === 'school'));
      html += '<div class="modeWrap"' + (pickOpen === k ? '' : ' hidden') + '><div class="mode' + (modeKeys.length > 4 ? ' many' : '') + '" style="box-shadow:0 0 0 4px var(--bg),0 0 0 7px ' + bypassColor + '" role="group" aria-label="Where you are during ' + esc(WB[k].name) + '">' + modeKeys.map(m => '<button data-w="' + k + '" data-m="' + m + '"' + (t === m ? ' class="on"' : '') + '>' + MODE_LABEL[m] + '</button>').join('') + '</div></div>';
    }
    if (k === 'sleep' || k === 'wind' || t || rs.length){
      const timed = rs.filter(r => r.use > 0 && !r.sug), addL = k === 'sleep' ? 'pre' : k === 'wind' ? 'night' : t || 'oo';
      const ws = wake + WB[k].from, we = wake + WB[k].to;
      const headGap = timed.length ? gapEl(ws, Math.min(...timed.map(r => r.start)), addL, k) : '';       // free time before the first task
      const tailGap = timed.length ? gapEl(Math.max(...timed.map(r => r.end)), we, addL, k) : '';          // free time after the last task
      const allGap = timed.length ? '' : gapEl(ws, we, addL, k);                                           // a block with nothing in it
      html += headGap + (rs.length ? gapRows(rs) : '<p class="wn">No tasks yet.</p>') + tailGap + allGap;
      const hasAdd = (headGap + tailGap + allGap).includes('class="add"');      // a free-time row already has its own button
      if ((editing && !hasAdd) || (!rs.length && !allGap)) html += '<button class="add" data-l="' + addL + '" data-w="' + k + '">+ Add task</button>';
    } else html += '<p class="wn">Choose where you are for this stretch and its tasks appear here.</p>';
    if (editing) html += '<button class="add" data-eb="' + k + '">Edit block</button>';
    return html;
  };
  $('#tl').innerHTML = '<div class="tlwrap">' + Object.keys(WIN).map(winSection).join('') + '</div>';
  buildSpine(); startWaves();
  $('#awayBtn').style.display = '';
  $('#awayBtn').classList.toggle('on', !!day.away);
  $('#awayBtn').textContent = day.away ? 'Away day: on' : 'Away day'; $('#awayBtn').setAttribute('aria-pressed', !!day.away);
  $('#awayHint').innerHTML = day.away ? ICONS.suitcase + '<span>Away day is on, so tasks are just suggestions. Tap Away day again to undo.</span>' : '';
  if (isToday) drawNowBanner(rows); else $('#nowBanner').classList.remove('show');
}

$('#wake').addEventListener('change', e => {
  if (!e.target.value) return;
  const [h, m] = e.target.value.split(':').map(Number);
  needLive(); wake = h*60 + m; saveDay(); render();
});
$('#reset').addEventListener('click', () => { wake = DEF_WAKE; saveDay(); render(); });
$('#reset').setAttribute('aria-label', 'Reset wake time to ' + fmt(DEF_WAKE).join(' '));
// Settings, Schedule: Sleep caps card. Caps are off until both times are set.
function drawCaps(){
  const hrs = c => ((wake + 1440 - c) / 60).toFixed(1), on = capsOn(), tv = c => Number.isFinite(c) ? toVal(c) : '';
  const row = (id, lab, v) => '<div class="capRow"><label for="' + id + '">' + lab + '</label><input type="time" id="' + id + '" value="' + tv(v) + '" data-def="' + (id === 'capS' ? '21:00' : '22:00') + '"><i>' + (Number.isFinite(v) ? hrs(v) + ' h before wake' : 'Not set') + '</i></div>';
  const note = on ? 'Past the soft cap, optional tasks are skipped. Past the hard cap, only core tasks stay. Your Night routine window is the 3 hours before the hard cap.'
    : (Number.isFinite(capDraft.soft) || Number.isFinite(capDraft.hard)) ? 'Set the other cap to turn them on.'
    : 'Off until you set both. While they are off, nothing is cut at night.';
  $('#sleep').innerHTML = '<p class="wn">' + note + '</p>' + row('capS', 'Soft cap', capDraft.soft) + row('capH', 'Hard cap', capDraft.hard) +
    (on && hrs(CAP.hard) < 7 ? '<p class="wn">Under 7 h between your hard cap and wake time. Most adults do better with 7 to 9 h, so consider an earlier cap or a later wake.</p>' : '') +
    (on ? '<button type="button" class="add" id="capOff" style="margin-top:10px">Turn caps off</button>' : '');
  if (EDUI) EDUI.enhanceTimes($('#sleep'));
}
$('#sleep').addEventListener('change', e => {
  if (!/^cap[SH]$/.test(e.target.id) || !e.target.value) return;
  const [h, m] = e.target.value.split(':').map(Number), mins = h * 60 + m, k = e.target.id === 'capS' ? 'soft' : 'hard';
  if (mins < 18 * 60){ toast('Sleep caps start at 6:00 PM. Pick a later time.'); render(); return; }
  const nx = { ...capDraft }; nx[k] = mins;
  if (Number.isFinite(nx.soft) && Number.isFinite(nx.hard) && nx.soft >= nx.hard){ toast('The soft cap needs to be earlier than the hard cap.'); render(); return; }
  capDraft = nx;
  if (Number.isFinite(nx.soft) && Number.isFinite(nx.hard)){ CAP.soft = nx.soft; CAP.hard = nx.hard; store.set('caps', { soft:CAP.soft, hard:CAP.hard }); }
  render();
});
$('#sleep').addEventListener('click', e => {
  if (!e.target.closest('#capOff')) return;
  CAP.soft = CAP.hard = null; capDraft = { soft:null, hard:null }; store.set('caps', {}); render();
});
// Settings, Schedule: School leave time card.
function drawLeave(){
  const set = LEAVE !== null, d = set ? (LEAVE - wake) / 60 : 0, ln = MODE_LABEL[LEAVE_FOR] || 'School';
  if ($('#leaveWn')) $('#leaveWn').textContent = 'When you leave on ' + ln + ' days. The morning routine shrinks to finish before it. With no time set, ' + ln + ' days run like Home days.';
  $('#leaveBox').innerHTML = '<div class="capRow"><label for="leaveT">Leave at</label><input type="time" id="leaveT" value="' + (set ? toVal(LEAVE) : '') + '" data-def="07:00"><i>' + (!set ? 'Not set' : d > 0 ? d.toFixed(1) + ' h after wake' : 'Before your wake time') + '</i></div>' +
    (set ? '<button type="button" class="add" id="leaveOff" style="margin-top:10px">Clear leave time</button>' : '');
  if (EDUI) EDUI.enhanceTimes($('#leaveBox'));
}
$('#leaveBox').addEventListener('change', e => {
  if (e.target.id !== 'leaveT' || !e.target.value) return;
  const [h, m] = e.target.value.split(':').map(Number);
  LEAVE = h * 60 + m; store.set('leave', LEAVE); applyLeave(); render();
});
$('#leaveBox').addEventListener('click', e => {
  if (!e.target.closest('#leaveOff')) return;
  LEAVE = null; store.set('leave', null); applyLeave(); render();
});
// Settings, Energy rhythm: what My rhythm has learned and what you can do about it.
function syncChrSel(){
  const sel = $('#chrSel'); if (!sel) return; sel.value = store.get('chrono', 'normal');
  const row = sel.closest('.capRow'); if (row) row.querySelectorAll('.segCtl button').forEach(b => b.classList.toggle('on', b.dataset.v === sel.value));
}
function rhyBasis(a){ return a.ratings + ' rating' + (a.ratings === 1 ? '' : 's') + ' over ' + a.days + ' day' + (a.days === 1 ? '' : 's'); }
function drawRhythm(){
  const box = $('#rhyBox'); if (!box) return;
  const a = rhyRead(), mine = store.get('chrono', 'normal') === 'mine', sh = myShift();
  const s = rhySuggest(a, { current:shiftInUse(), today:todayStr(), guard:rhyGuard(a) });   // Settings ignores "Not now" and "Never": you are asking
  let html = '';
  if (mine){
    html += '<p class="wn">' + (sh === 0 ? 'Your windows are on the standard times for now.' : 'Your windows are shifted <b>' + shiftWords(sh) + '</b> from the standard times.') + (a.ratings ? ' Based on ' + rhyBasis(a) + '.' : '') + '</p>';
    if (s.show) html += '<p class="wn">Your ratings now point to <b>' + shiftWords(s.shift) + '</b>' + (s.limited ? ', held back so your evening does not run into your night routine' : '') + '.</p><button type="button" class="add" data-rhy="apply">' + (sh === 0 ? 'Use ' : 'Update to ') + shiftWords(s.shift) + '</button>';
    if (sh !== 0) html += '<button type="button" class="add" data-rhy="peak">Move tasks into my peak</button>';
    html += '<button type="button" class="add" data-rhy="reset">Reset to In between</button>';
  } else {
    const t = { 'need-data':'Still learning (' + rhyBasis(a) + '). Rate your energy a few times a day, at different times. About a week of ratings is enough for a first suggestion.',
      'need-spread':'Your ratings are bunched into one part of the day. Try rating in the late morning and afternoon too.',
      'flat':'Your ratings are about the same all day, so there is no clear peak to learn from yet.',
      'irregular':'Your wake-up time changes a lot from day to day, so I cannot read a pattern yet.',
      'learning':'Getting closer (' + rhyBasis(a) + '). A few more days of ratings and I can suggest a shift.' }[a.status];
    html += '<p class="wn">' + (t || (s.show ? 'Your ratings point to <b>' + shiftWords(s.shift) + '</b> from the standard times (based on ' + rhyBasis(a) + ')' + (s.limited ? ', held back so your evening does not run into your night routine' : '') + '.' : s.reason === 'night-guard' ? 'Your ratings point to a different rhythm, but moving the windows would squeeze your evening into your night routine, so they stay as they are.' : 'Your ratings match your current windows, so there is nothing to change. Based on ' + rhyBasis(a) + '.')) + '</p>';
    if (s.show) html += '<button type="button" class="add" data-rhy="apply">Use My rhythm (' + shiftWords(s.shift) + ')</button>';
  }
  box.innerHTML = html;
}
// The suggestion card in History, under "Energy by window".
function rhyCard(){
  const a = rhyRead(), s = rhyAsk(a), gap = s.shift - shiftInUse();
  if (s.show){
    return '<div class="rhyCard"><p class="wn">Your energy seems to peak about <b>' + Math.abs(gap) + ' min ' + (gap < 0 ? 'earlier' : 'later') + '</b> than your current windows (based on ' + rhyBasis(a) + ').' + (s.limited ? ' Held back a little so your evening does not run into your night routine.' : '') + '</p>' +
      '<div class="rhyBtns"><button type="button" class="add" data-rhy="apply">Use My rhythm</button><button type="button" class="add" data-rhy="snooze">Not now</button><button type="button" class="add" data-rhy="never">Never</button></div></div>';
  }
  if (s.reason === 'night-guard' && !rhyState().never) return '<p class="wn">Your energy seems to peak about ' + Math.abs(a.shift - shiftInUse()) + ' min ' + (a.shift < shiftInUse() ? 'earlier' : 'later') + ' than your current windows, but moving them would squeeze your evening into your night routine, so I am leaving them as they are.</p>';
  return '';
}
// Move tasks into the Sustained Peak: tasks without a set time that sit in another window, picked by you.
let pkPick = new Set();
function peakCandidates(){
  const seen = new Map();
  WIN_LISTS.forEach(l => getBlocks(l).forEach(b => {
    if (!b || b.sug || b.fixed !== undefined || b.at !== undefined) return;
    const w = b.w || 'climb1'; if (w === 'peak' || w === 'sleep' || w === 'wind' || !WIN[w]) return;
    if (!seen.has(String(b.id))) seen.set(String(b.id), { id:b.id, t:b.t, w, core:b.p === 'core' });
  }));
  return [...seen.values()].sort((a, b) => (b.core - a.core) || a.t.localeCompare(b.t)).slice(0, 14);
}
function openPeakSheet(){
  const WB = wins(), P = WB.peak, c = peakCandidates(); pkPick = new Set();
  $('#pk_sub').textContent = c.length ? 'Your Sustained Peak is now ' + range(wake + P.from, wake + P.to) + '. Pick the tasks that need your best focus and they move into that window. Their clock time still follows the tasks before them, unless you give them a start time.' : 'Nothing to move: every task without a set time is already in your Sustained Peak, or has its own time.';
  $('#pk_list').innerHTML = c.map(x => '<button type="button" data-id="' + esc(String(x.id)) + '">' + esc(x.t) + ' <small>' + esc(WB[x.w] ? WB[x.w].name : '') + '</small></button>').join('');
  $('#pk_ok').hidden = !c.length; $('#pk_ok').textContent = 'Move'; $('#pk_ok').disabled = true;
  $('#pkDlg').showModal(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
$('#pk_list').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const id = b.dataset.id; if (pkPick.has(id)) pkPick.delete(id); else pkPick.add(id); b.classList.toggle('on', pkPick.has(id)); $('#pk_ok').disabled = !pkPick.size; $('#pk_ok').textContent = pkPick.size ? 'Move ' + pkPick.size + (pkPick.size === 1 ? ' task' : ' tasks') : 'Move'; });
$('#pk_x').onclick = () => $('#pkDlg').close();
$('#pk_ok').onclick = () => {
  if (!pkPick.size) return;
  const before = clone(store.get('blocks', null) || {}), n = pkPick.size;
  WIN_LISTS.forEach(l => { const arr = clone(getBlocks(l)); let ch = false; arr.forEach(b => { if (pkPick.has(String(b.id))){ b.w = 'peak'; ch = true; } }); if (ch) setBlocks(l, arr); });
  $('#pkDlg').close(); render();
  toast(n + (n === 1 ? ' task' : ' tasks') + ' moved to your peak', 'Undo', () => { store.set('blocks', before); render(); });
};
// Data for the Energy over the day chart in History: a few ratings are needed before it shows.
const chartTime = m => { const t = ((Math.round(m) % 1440) + 1440) % 1440, h = Math.floor(t / 60), mm = t % 60, p = String(mm).padStart(2, '0'); return CLOCK24 ? String(h).padStart(2, '0') + (mm ? ':' + p : '') : ((h + 11) % 12 + 1) + (mm ? ':' + p : '') + (h < 12 ? 'a' : 'p'); };
function eChartData(){
  const L = store.get('energy', []), t = todayStr(), rs = rhyClean(L, t); if (rs.length < 6) return null;
  const a = rhyRead(), WB = wins(), usual = Number.isFinite(a.usualWake) ? a.usualWake : wake;
  return { curve:rhyCurve(L, t), ratings:rs.length, days:new Set(rs.map(r => r.d)).size, peak:(a.status === 'ready' || a.status === 'learning') && a.centre !== null ? { from:a.centre - 90, to:a.centre + 90 } : null,
    bands:Object.keys(WB).map(k => ({ from:WB[k].from, to:WB[k].to, color:safeCol(WB[k].color) || (WIN_STYLE[k] && WIN_STYLE[k].c), name:WB[k].name })),
    time:m => chartTime(usual + m), long:m => fmt(usual + m).join(' ').trim() };
}
function rhyDone(){ syncChrSel(); render(); drawRhythm(); if (typeof drawHistory === 'function') drawHistory(); }
function rhyAct(kind){
  if (kind === 'peak'){ openPeakSheet(); return; }
  const prev = { chrono:store.get('chrono', 'normal'), rhythm:JSON.parse(JSON.stringify(rhyState())) }, a = rhyRead(), r = { ...rhyState() };
  const undo = () => { store.set('chrono', prev.chrono); store.set('rhythm', prev.rhythm); rhyDone(); };
  if (kind === 'apply'){
    const s = rhyAsk(a, { never:false, snooze:null }); if (!s.show){ toast('Nothing to change right now'); return; }
    r.shift = s.shift; r.on = true; r.snooze = null; store.set('rhythm', r); store.set('chrono', 'mine'); rhyDone();
    toast('My rhythm is on: ' + shiftWords(s.shift), 'Undo', undo);
  } else if (kind === 'snooze'){
    r.snooze = { at:todayStr(), n:a.total }; store.set('rhythm', r); rhyDone(); toast('Okay, I will ask again later');
  } else if (kind === 'never'){
    r.never = true; store.set('rhythm', r); rhyDone(); toast('I will stop suggesting. You can still pick My rhythm in Settings.');
  } else if (kind === 'reset'){
    delete r.shift; r.on = false; store.set('rhythm', r); store.set('chrono', 'normal'); rhyDone();
    toast('Back to In between', 'Undo', undo);
  }
}
$('#awayBtn').addEventListener('click', () => {
  needLive();
  day.away = !day.away;
  if (day.away){ day.prevTypes = { ...day.types }; Object.keys(WIN).forEach(k => { if (k !== 'sleep' && k !== 'wind') day.types[k] = 'away'; }); }
  else { day.types = day.prevTypes || {}; delete day.prevTypes; }
  saveDay(); render();
});
$('#tl').addEventListener('click', e => {
  const mc = e.target.closest('.mchip');
  if (mc){ pickOpen = pickOpen === mc.dataset.chip ? null : mc.dataset.chip; render(); return; }
  const mb = e.target.closest('.mode button');
  if (mb){ pickType(mb.dataset.w, mb.dataset.m); return; }
  if (lpFired){ lpFired = false; return; }
  const nmk = e.target.closest('.noteMark');
  if (nmk){
    e.stopPropagation();
    const nk = noteKey(nmk.closest('.tlrow').dataset.id);
    if (shownNotes.has(nk)) shownNotes.delete(nk); else shownNotes.add(nk);
    render(); return;
  }
  const nsh = e.target.closest('.noteShow');
  if (nsh){ noteEditing = nsh.dataset.nid; render(); return; }
  const nb = e.target.closest('.noteBtn');
  if (nb){ noteEditing = nb.dataset.nid; render(); return; }
  if (e.target.closest('.ncancel')){ noteEditing = null; render(); return; }
  const ns = e.target.closest('.nsave');
  if (ns){
    const id = ns.dataset.nid, txt = e.target.closest('.noteEdit').querySelector('.ntxt').value.trim();
    setNote(id, txt);
    if (!txt) shownNotes.delete(noteKey(id));   // notes stay hidden until you tap the note icon
    noteEditing = null; render(); if (txt) toast('Note saved'); return;
  }
  const ad = e.target.closest('.add');
  if (ad){
    if (ad.dataset.eb) openBlockEd(ad.dataset.eb);
    else openEd(ad.dataset.l, null, ad.dataset.w, ad.dataset.s === undefined ? undefined : Number(ad.dataset.s));
    return;
  }
  const hd = e.target.closest('.tlhead');
  if (hd){ openBlockInfo(hd.dataset.k); return; }
  const sb = e.target.closest('.stepsBtn');
  if (sb){ openStepsSheet(sb.dataset.sid); return; }
  const row = e.target.closest('.tlrow'); if (!row) return;
  if (editing){ openEd(row.dataset.l, row.dataset.id); return; }
  const chk = e.target.closest('.tlcheck');
  if (chk){
    if (row.dataset.locked === '1') return;
    const key = row.dataset.id, i = done.ids.indexOf(key);
    if (i === -1) done.ids.push(key); else done.ids.splice(i, 1);
    if (navigator.vibrate) navigator.vibrate(i === -1 ? 12 : 6);
    saveDay(); render(); if (i === -1) offerTickAll(key); return;
  }
  openTaskSheet(row.dataset.l, row.dataset.id);
});
// ============================================================
// NOW BANNER, CHIME, CLOCK
// ============================================================
let lastNowId = undefined;
function chime(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.6);
  }catch{}
}
function drawNowBanner(rows){
  const NM = nowM(), cur = rows.find(r => r.use > 0 && !r.sug && NM >= r.start && NM < r.end);
  if (lastNowId === undefined) lastNowId = cur ? cur.id : null;
  else if ((cur ? cur.id : null) !== lastNowId){ lastNowId = cur ? cur.id : null; chime(); }
  const b = $('#nowBanner');
  if (!cur){ b.classList.remove('show'); return; }
  const st = WIN_STYLE[cur.w] || WIN_STYLE.climb1, left = cur.end - NM;
  $('#nb-i').innerHTML = iconMarkup(cur.icon || st.i);
  { const nt = 'Now: ' + cur.t; if ($('#nb-t').textContent !== nt) $('#nb-t').textContent = nt; }
  $('#nb-s').textContent = (left <= 1 ? 'less than a minute left' : left + ' min left');
  { const pct = Math.max(0, Math.min(100, Math.round((NM - cur.start) / Math.max(1, cur.end - cur.start) * 100))); const bar = $('#nbBar'); if (bar) bar.style.width = pct + '%'; }
  b.style.setProperty('--nb', cur.color || st.c);
  b.classList.add('show');
}
function drawClock(){ $('#clk').textContent = fmt(nowM()).join(' '); }
drawClock(); setInterval(drawClock, 15000);
function dayTick(){
  if (todayStr() !== lastToday){ const was = viewDate === lastToday; lastToday = todayStr(); if (was){ goDate(lastToday); return; } }
  if (viewDate === todayStr() && !document.querySelector('.hday[open]') && noteEditing === null && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) draw();
}
setInterval(dayTick, 20000);
$('#dnote').value = day.note || '';
$('#dnote').addEventListener('input', e => { day.note = e.target.value; saveDay(); });
// ============================================================
// IN-APP MESSAGES: replace the browser's confirm() and alert() popups
// ask(text, opts) -> Promise<boolean>.  tell(text) -> shows a message with one OK button.
// opts: title, ok (button text), cancel (button text), danger (red OK), info (no Cancel button)
// ============================================================
var mdResolve = null;
function mdClose(v){ const d = $('#msgDlg'), r = mdResolve; mdResolve = null; if (d.open) d.close(); if (r) r(v); }
function ask(text, opts = {}){
  return new Promise(res => {
    if (mdResolve) mdClose(false);
    mdResolve = res;
    const t = $('#md_title'); t.textContent = opts.title || ''; t.hidden = !opts.title;
    $('#md_text').textContent = text;
    const no = $('#md_no'), ok = $('#md_ok');
    no.hidden = !!opts.info; no.textContent = opts.cancel || 'Cancel';
    ok.textContent = opts.ok || 'OK'; ok.classList.toggle('danger', !!opts.danger);
    $('#msgDlg').showModal();
    (opts.info ? ok : no).focus();       // for questions the safe choice (Cancel) is the one highlighted
  });
}
const tell = text => ask(text, { info:true });
$('#md_ok').onclick = () => mdClose(true);
$('#md_no').onclick = () => mdClose(false);
$('#msgDlg').addEventListener('close', () => { const r = mdResolve; mdResolve = null; if (r) r(false); });   // Esc or the Android back button

// ============================================================
// IMPORT / EXPORT / RESET
// ============================================================
// Backup files keep the v2 layout (keys carry the yotei_v2_ prefix), so they stay readable by older versions.
function backupData(){ const o = {}; Object.entries(store.dump()).forEach(([k, v]) => { o['yotei_v2_' + k] = v; }); return o; }
// In the Android app a page cannot download a file by itself. Export saves straight into Downloads/Yotei through a small piece of
// native code (YoteiFiles). Share keeps using Android's share sheet. If the native part is missing, Export falls back to the share sheet.
async function shareBackupNative(name, json){
  const fs = nativePlugin('Filesystem'), sh = nativePlugin('Share'); if (!fs || !sh) return false;
  try{
    const r = await fs.writeFile({ path:name, data:json, directory:'CACHE', encoding:'utf8' });
    await sh.share({ title:'Yoteii backup', url:r.uri, dialogTitle:'Save your Yoteii backup' });
    store.set('lastBackup', Date.now()); updateBackupInfo();
  }catch(e){ if (!/cancel/i.test(String((e && e.message) || e))) tell('Could not save the backup. Please try again.'); }
  return true;
}
async function saveBackupNative(name, json){
  const yf = nativePlugin('YoteiFiles');
  if (yf){
    try{ await yf.saveToDownloads({ name, data:json, mime:'application/json' }); store.set('lastBackup', Date.now()); updateBackupInfo(); toast('Saved to Downloads/Yotei'); return true; }
    catch(e){ /* fall through to the share sheet */ }
  }
  return shareBackupNative(name, json);
}

// ---- automatic weekly backup (the Android app): one file a week in Downloads/Yotei, the latest 8 are kept ----
const AUTO_DAYS = 7, AUTO_KEEP = 8;
const autoBackupOn = () => store.get('autoBackup', true) !== false;
async function autoBackupMaybe(){
  if (!IS_NATIVE || !autoBackupOn()) return;
  const yf = nativePlugin('YoteiFiles'); if (!yf) return;
  if (Date.now() - store.get('lastAutoBackup', 0) < AUTO_DAYS * 864e5) return;
  if (!Object.keys(store.get('hist', {})).length && !Object.keys(store.get('plans', {})).length) return;      // nothing worth saving yet
  try{
    await yf.saveToDownloads({ name:'yotei-auto-' + todayStr() + '.json', data:backupJson(), mime:'application/json' });
    store.set('lastAutoBackup', Date.now()); store.set('lastBackup', Date.now()); updateBackupInfo(); drawAutoBackup();
    try{ await yf.trimBackups({ prefix:'yotei-auto-', keep:AUTO_KEEP }); }catch{}
  }catch{}
}
function drawAutoBackup(){
  const box = $('#abBox'); if (!box) return;
  box.hidden = !IS_NATIVE; if (!IS_NATIVE) return;
  const on = autoBackupOn(), t = store.get('lastAutoBackup', 0);
  $('#abInfo').textContent = 'Export saves into Downloads/Yotei. ' + (on ? 'Automatic weekly backup is on' + (t ? ' (last one ' + new Date(t).toLocaleDateString(undefined, { month:'short', day:'numeric' }) + ')' : '') + ', keeping the latest ' + AUTO_KEEP + '.' : 'Automatic weekly backup is off.');
  $('#abToggle').textContent = on ? 'Turn off automatic backup' : 'Turn on automatic backup';
}
$('#abToggle').addEventListener('click', () => { store.set('autoBackup', !autoBackupOn()); drawAutoBackup(); if (autoBackupOn()) autoBackupMaybe(); });
drawAutoBackup();
if (IS_NATIVE) setTimeout(autoBackupMaybe, 4000);
async function exportData(){
  if (await saveBackupNative('yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ app:'yotei', v:3, data:backupData() }))) return;
  const o = backupData();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app:'yotei', v:3, data:o })], { type:'application/json' }));
  a.download = 'yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove(); store.set('lastBackup', Date.now()); updateBackupInfo();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importData(file){
  if (file.size > 8 * 1024 * 1024){ tell('That file is too large to be a Yoteii backup. Nothing was changed.'); return; }
  const r = new FileReader();
  r.onload = async () => {
    let j = null;
    try{ j = JSON.parse(r.result); }catch{}
    const P = 'yotei_v2_';
    const chk = validateBackup(j, P);
    if (!chk.ok){ tell('That file can\'t be used as a Yoteii backup because ' + chk.why + '. Nothing was changed.'); return; }
    if (!await ask('Replace everything in Yoteii with this backup?', { ok:'Replace', danger:true })) return;
    const old = store.dump(); let data = {};
    Object.keys(j.data).forEach(k => { data[k.slice(P.length)] = j.data[k]; });
    if (needsDateMigration(data)) data = migrateDates(data);   // backups from v2 use the old day format
    try{ await makeSnapshot('before-import'); }catch{}
    try{ await replaceAll(data); }
    catch{
      try{ await replaceAll(old); }catch{}
      tell('Import failed, possibly because storage is full. Your previous data was restored.');
      return;
    }
    location.reload();
  };
  r.readAsText(file);
}
$('#rst').addEventListener('click', async () => { if (await ask('Remove every routine task and reset all block names, colors and times? Your history is kept. You can undo this right after.', { ok:'Reset', danger:true })){ const snap = grab(); ['blocks', 'wins', 'ovr', 'wovr'].forEach(k => store.remove(k)); render(); showUndo('Routine reset', snap); } });
$('#exp').onclick = exportData;
async function openSnaps(){
  const why = { daily:'Daily', 'before-import':'Before an import', 'before-restore':'Before a restore', 'before-upgrade':'Before the update' };
  let L = []; try{ L = await listSnapshots(); }catch{}
  $('#snapList').innerHTML = L.length
    ? L.map(x => '<div class="snapRow"><span>' + esc(new Date(x.at).toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })) + ' · ' + esc(why[x.reason] || x.reason) + '</span><button data-id="' + esc(x.id) + '">Restore</button></div>').join('')
    : '<p class="wn">' + (info().backend === 'idb' ? 'No snapshots yet. The first one is saved the next time you open Yoteii on a new day.' : 'Snapshots are not available ' + (IS_NATIVE ? 'on this device.' : 'in this browser.')) + '</p>';
  $('#snapDlg').showModal();
}
$('#snapBtn').onclick = openSnaps;
$('#snap_x').onclick = () => $('#snapDlg').close();
$('#snapList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  if (!await ask('Replace everything in Yoteii with this snapshot? Your current data is saved as a snapshot first.', { ok:'Replace', danger:true })) return;
  try{ await restoreSnapshot(b.dataset.id); location.reload(); }catch{ tell('Could not restore that snapshot. Nothing was changed.'); }
});
$('#imp').onclick = () => $('#impf').click();
$('#impf').onchange = e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; };
let lastToday = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayStr() !== lastToday){ lastToday = todayStr(); goDate(lastToday); }
});
$('#tl').addEventListener('toggle', e => {
  const d = e.target;
  if (d.dataset && d.dataset.k){ openState[d.dataset.k] = d.open; store.set('open', openState); }
}, true);
$('#dateBtn').addEventListener('click', () => openJump());
$('#hdrTitle').addEventListener('click', () => { if ((document.body.dataset.tab || 'home') === 'home') openJump(); });
$('#hdrTitle').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && (document.body.dataset.tab || 'home') === 'home'){ e.preventDefault(); openJump(); } });
$('#hdrToday').addEventListener('click', () => goDate(todayStr()));
// ============================================================
// GESTURES — long-press to edit, swipe on the week strip
// ============================================================
let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
function lpClear(){ clearTimeout(lpTimer); lpTimer = null; }
$('#tl').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('.dragH') || e.target.closest('.mchip') || e.target.closest('.runBtn')) return;
  const row = e.target.closest('.tlrow'), head = e.target.closest('.tlhead');
  if (!row && !head) return;
  lpFired = false; lpX = e.clientX; lpY = e.clientY;
  lpTimer = setTimeout(() => {
    lpFired = true;
    if (navigator.vibrate) navigator.vibrate(12);
    if (row) dragCand = { row, x:lpX, y:lpY }; else openBlockEd(head.dataset.k);
  }, 420);
});
$('#tl').addEventListener('pointermove', e => { if (lpTimer && (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10)) lpClear(); });
['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => { lpClear(); setTimeout(() => { lpFired = false; }, 50); }));
$('#tl').addEventListener('contextmenu', e => { if (e.target.closest('.tlrow, .tlhead')) e.preventDefault(); });
let swX = null, swY = null, swFired = false;
let dayLp = null;
$('#nbDone').addEventListener('click', () => { const c = document.querySelector('.tlrow.now .tlcheck'); if (c) c.click(); });
$('#weekstrip').addEventListener('pointerdown', e => {
  swX = e.clientX; swY = e.clientY; swFired = false;
  const b = e.target.closest('.wd'); clearTimeout(dayLp); dayLp = null;
  if (b) dayLp = setTimeout(() => { dayLp = null; swFired = true; if (navigator.vibrate) try{ navigator.vibrate(12); }catch{} openDayMenu(b.dataset.d); }, 450);
});
$('#weekstrip').addEventListener('pointermove', e => { if (dayLp && swX !== null && Math.abs(e.clientX - swX) > 10){ clearTimeout(dayLp); dayLp = null; } });
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => $('#weekstrip').addEventListener(t, () => { clearTimeout(dayLp); dayLp = null; }));
$('#weekstrip').addEventListener('contextmenu', e => e.preventDefault());
$('#weekstrip').addEventListener('pointerup', e => {
  if (swX === null) return;
  const dx = e.clientX - swX, dy = e.clientY - swY;
  swX = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)){
    swFired = true;
    const d = parseDay(viewDate); d.setDate(d.getDate() + (dx < 0 ? 7 : -7));
    goDate(isoLocal(d));
  }
});
let dsX = null, dsY = null, dsT = 0, dsFired = 0;
const dsSkip = '.mchip,.modeWrap,.mode,.noteEdit,.dragH,input,textarea,select,button.add,.wakerow';
$('.panel').addEventListener('pointerdown', e => {
  dsX = (drag || dragCand || e.target.closest(dsSkip)) ? null : e.clientX; dsY = e.clientY; dsT = Date.now();
});
$('.panel').addEventListener('pointerup', e => {
  if (dsX === null) return;
  const dx = e.clientX - dsX, dy = e.clientY - dsY; dsX = null;
  if (drag || dragCand || Date.now() - dsT > 800) return;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5){
    dsFired = Date.now();
    const d = parseDay(viewDate); d.setDate(d.getDate() + (dx < 0 ? 1 : -1));
    goDate(isoLocal(d));
  }
});
$('.panel').addEventListener('pointercancel', () => { dsX = null; });
$('.panel').addEventListener('click', e => { if (Date.now() - dsFired < 400){ e.stopPropagation(); e.preventDefault(); } }, true);
// ---- keyboard: when it opens the page shrinks, so hide the tab bar, + button and week strip and keep the field in view ----
let vhMax = innerHeight, vwLast = innerWidth;
function kbUpdate(){
  if (innerWidth !== vwLast){ vwLast = innerWidth; vhMax = innerHeight; }          // rotated: measure again
  vhMax = Math.max(vhMax, innerHeight);
  const ae = document.activeElement;
  const typing = !!ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !/^(checkbox|radio|button|file|range|color|submit)$/.test(ae.type || '');
  const open = typing && innerHeight < vhMax - 120, was = document.body.classList.contains('kb');
  document.body.classList.toggle('kb', open);
  if (open && !was && !ae.closest('dialog')) setTimeout(() => { try{ ae.scrollIntoView({ block:'center', behavior:'smooth' }); }catch{} }, 120);
}
window.addEventListener('resize', kbUpdate);
document.addEventListener('focusin', () => setTimeout(kbUpdate, 250));
document.addEventListener('focusout', () => setTimeout(kbUpdate, 100));
function setTopH(){ const t = document.querySelector('.top'); if (t) document.documentElement.style.setProperty('--topH', t.getBoundingClientRect().height + 'px'); }
setTopH(); window.addEventListener('resize', setTopH);
if (window.ResizeObserver) new ResizeObserver(setTopH).observe(document.querySelector('.top'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(setTopH);
$('#weekstrip').addEventListener('click', e => {
  if (swFired){ swFired = false; return; }
  const nv = e.target.closest('.wsNav'); if (nv){ goDate(addDays(viewDate, 7 * Number(nv.dataset.nav))); return; }
  const b = e.target.closest('.wd'); if (!b) return;
  goDate(b.dataset.d);
});
// ============================================================
// TABS & INIT
// ============================================================
$('#tl').addEventListener('keydown', e => {
  const sb = e.target.closest && e.target.closest('.stepsBtn');
  if (sb && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); e.stopPropagation(); openStepsSheet(sb.dataset.sid); }
});
// ============================================================
// ABOUT & CHANGELOG (Settings tab)
// To ship a release: add an entry at the TOP of CHANGELOG, bump
// APP_VERSION, and bump the CACHE name in sw.js so devices update.
// ============================================================
// ============================================================
// RUN MODE, STREAKS + WEEK VIEW, TEMPLATES, REMINDERS
// ============================================================
let run = null, runTimer = null, wakeLock = null;
function runStart(k){
  const q = schedule().rows.filter(r => r.w === k && r.use > 0 && !r.sug && !done.ids.includes(r.id));
  if (!q.length) return;
  run = { k, q, i:0, left:q[0].use * 60, paused:false, last:Date.now(), beeped:false };
  runDraw(); $('#runDlg').showModal();
  clearInterval(runTimer); runTimer = setInterval(runTick, 250);
  try{ if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); }catch{}
}
function runBeep(){
  try{
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    const A = new (window.AudioContext || window.webkitAudioContext)(), o = A.createOscillator(), g = A.createGain();
    o.connect(g); g.connect(A.destination); o.frequency.value = 660; g.gain.value = .08; o.start();
    setTimeout(() => { o.stop(); A.close(); }, 350);
  }catch{}
}
function runDraw(){
  const r = run.q[run.i], st = WIN_STYLE[run.k];
  $('#runStep').textContent = 'Step ' + (run.i + 1) + ' of ' + run.q.length;
  $('#runIcon').innerHTML = iconMarkup(r.icon || guessIcon(r.t) || st.i);
  $('#runTitle').textContent = r.t;
  $('#runDet').textContent = r.details || '';
  $('#runPause').textContent = run.paused ? 'Resume' : 'Pause';
  $('#runDone').textContent = run.i === run.q.length - 1 ? 'Finish' : 'Done';
  runTick();
}
function runTick(){
  if (!run) return;
  const now = Date.now();
  if (!run.paused) run.left -= (now - run.last) / 1000;
  run.last = now;
  const total = run.q[run.i].use * 60, over = run.left < 0, sec = Math.ceil(Math.abs(run.left));
  $('#runTime').textContent = (over ? '+' : '') + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  $('#runTime').classList.toggle('over', over);
  $('#runBar').style.width = Math.max(0, Math.min(100, (1 - run.left / total) * 100)) + '%';
  if (over && !run.beeped){ run.beeped = true; runBeep(); }
}
function runNext(mark){
  const r = run.q[run.i];
  if (mark && !done.ids.includes(r.id)){ done.ids.push(r.id); saveDay(); }
  run.i++;
  if (run.i >= run.q.length){ runEnd(); return; }
  run.left = run.q[run.i].use * 60; run.beeped = false; run.last = Date.now(); runDraw();
}
function runEnd(){
  clearInterval(runTimer); run = null;
  try{ if (wakeLock) wakeLock.release(); }catch{}
  wakeLock = null;
  if ($('#runDlg').open) $('#runDlg').close();
  render();
}
$('#runPause').onclick = () => { run.paused = !run.paused; run.last = Date.now(); runDraw(); };
$('#runPlus').onclick = () => { run.left += 60; run.beeped = false; runTick(); };
$('#runSkip').onclick = () => runNext(false);
$('#runDone').onclick = () => runNext(true);
$('#runClose').onclick = runEnd;
$('#runDlg').addEventListener('close', () => { if (run) runEnd(); });
$('#tl').addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.runBtn');
  if (b){ e.stopPropagation(); runStart(b.dataset.run); }
}, true);

$('#trends').addEventListener('click', e => {
  const rb = e.target.closest('[data-rhy]'); if (rb){ rhyAct(rb.dataset.rhy); return; }
  const ch = e.target.closest('[data-chr]');
  if (ch){ store.set('chrono', ch.dataset.chr); syncChrSel(); render(); toast('Energy rhythm updated'); return; }
  const hr = e.target.closest('[data-hr]');
  if (hr){ histUI.kind = hr.dataset.hr; histUI.off = 0; store.set('histRange', histUI.kind); drawHistory(); return; }
  const hn = e.target.closest('[data-hn]');
  if (hn){ if (!hn.disabled){ const n = Number(hn.dataset.hn); histUI.off = n === 0 ? 0 : Math.min(0, histUI.off + n); drawHistory(); } return; }
  const hs = e.target.closest('[data-hsec]');
  if (hs){ const k = hs.dataset.hsec; if (histUI.hide.has(k)) histUI.hide.delete(k); else histUI.hide.add(k); store.set('histHide', [...histUI.hide]); drawHistory(); return; }
  const c = e.target.closest('.hvC[data-d]');
  if (c){ setTab('home'); goDate(c.dataset.d); }
});

function tplApply(list, name){
  const bl = store.get('blocks', null) || {};
  bl[list] = TPL[list].sets[name].map((x, i) => ({ id:'t' + Date.now().toString(36) + list.charAt(0) + i + Math.random().toString(36).slice(2, 5), t:x[0], d:x[1], m:x[2], p:x[3] }));
  store.set('blocks', bl);
}
async function applyTpl(list, name){
  const min = TPL[list].sets[name].reduce((a, x) => a + x[1], 0);
  if (!await ask('Replace your ' + TPL[list].label.toLowerCase() + ' with "' + name + '" (' + min + ' min)? Your current list for this routine will be overwritten.', { ok:'Replace' })) return;
  tplApply(list, name); render();
}
// ---- Android app: reminders are handed to the phone's alarm system, so they fire when the app is closed ----
var remNative = { perm:null, exact:null }, remTimer = null, remBusy = false, remAgain = false, remSig = null;
const REM_DAYS = 3, REM_CHANNEL = 'yotei-reminders', REM_TEST_ID = 1, NUDGE_CHANNEL = 'yotei-checkins', NUDGES_PER_DAY = 3;
async function remNativeState(){
  const LN = nativePlugin('LocalNotifications'); if (!LN) return;
  try{ remNative.perm = (await LN.checkPermissions()).display; }catch{}
  try{ remNative.exact = (await LN.checkExactNotificationSetting()).exact_alarm; }catch{ remNative.exact = 'granted'; }
  const c = $('#remCard'); if (c) c.innerHTML = remCard();
}
function remRowsFor(ds){
  const sv = { wake, day, done };
  try{ loadDay(ds); return { rows: build(dowOf(ds)).rows, done: done.ids.slice(), wk: wake }; }
  finally{ wake = sv.wake; day = sv.day; done = sv.done; }
}
function remId(s){ let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h & 0x7fffffff) || 2; }
function remPlan(R){
  const out = [], now = Date.now(), seen = new Set(), nudge = !!store.get('enNudge', {}).on, rated = store.get('energy', []);
  for (let i = 0; i < REM_DAYS; i++){
    const d = parseDay(todayStr()); d.setDate(d.getDate() + i);
    const ds = isoLocal(d), { rows, done: dn, wk } = remRowsFor(ds);
    if (nudge) nudgeTimes(ds, NUDGES_PER_DAY).forEach((off, k) => {    // energy check-ins: spread across the day, skipped near a rating you already made, never close to bedtime
      const m = wk + off, at = parseDay(ds); at.setHours(0, m, 0, 0);
      if (m >= 1440 || (capsOn() && m >= CAP.soft) || at.getTime() <= now + 2000 || rated.some(r => r && r.d === ds && Math.abs(r.o - off) < 45)) return;
      let id = remId('en|' + ds + '|' + k); while (id === REM_TEST_ID || seen.has(id)) id++; seen.add(id);
      out.push({ id, at, ds, en:true, title:'How is your energy?', body:'Tap to rate it from 1 to 5.' });
    });
    if (R.on) rows.filter(r => r.use > 0 && !r.sug && !dn.includes(r.id)).forEach(r => {
      const at = parseDay(ds); at.setHours(0, r.start - R.lead, 0, 0);
      if (at.getTime() <= now + 2000) return;
      let id = remId(ds + '|' + r.id + '|' + r.start); while (id === REM_TEST_ID || seen.has(id)) id++; seen.add(id);
      out.push({ id, at, ds, rid: r.id, t: r.t, title: R.lead ? r.t + ' in ' + R.lead + ' min' : 'Time for ' + r.t, body: range(r.start, r.end) });
    });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 60);
}
function remSoon(force){
  if (!IS_NATIVE) return;
  if (force) remSig = null;
  clearTimeout(remTimer); remTimer = setTimeout(remSync, 2500);
}
const REM_ACTIONS = 'TASK';
async function remActions(LN){ try{ await LN.registerActionTypes({ types:[{ id:REM_ACTIONS, actions:[{ id:'done', title:'Done' }, { id:'snooze', title:'Snooze 10 min' }] }] }); }catch{} }
function markDoneFor(ds, id){
  const sv = { vd:viewDate, wake, day, done };
  try{ viewDate = ds; loadDay(ds); if (!done.ids.includes(id)) done.ids.push(id); saveDay(); }
  finally{ viewDate = sv.vd; wake = sv.wake; day = sv.day; done = sv.done; }
  render();
}
async function onNotifAction(ev){
  const LN = nativePlugin('LocalNotifications'), n = ev && ev.notification, ex = (n && n.extra) || {};
  if (LN && ex.en){ goDate(todayStr()); setTab('home'); return; }     // an energy check-in: open today, where you rate it
  if (!LN || !ex.ds || !ex.rid) return;
  try{ await LN.cancel({ notifications:[{ id:n.id }] }); }catch{}
  if (ev.actionId === 'done'){ markDoneFor(ex.ds, ex.rid); remSoon(true); toast('Marked done: ' + (ex.t || 'task')); }
  else if (ev.actionId === 'snooze'){
    const at = new Date(Date.now() + 10 * 60000), id = remId('snz|' + ex.ds + '|' + ex.rid + '|' + at.getTime());
    try{
      await remChannel(LN); await remActions(LN);
      await LN.schedule({ notifications:[{ id, title:(ex.t || 'Task'), body:'Snoozed for 10 minutes', channelId:REM_CHANNEL, actionTypeId:REM_ACTIONS, extra:ex, schedule:{ at, allowWhileIdle:true } }] });
      store.set('snz', store.get('snz', []).filter(s => s.at > Date.now()).concat({ id, at:at.getTime() })); toast('Snoozed for 10 minutes');
    }catch{}
  }
}
if (IS_NATIVE){ const LN0 = nativePlugin('LocalNotifications'); if (LN0 && LN0.addListener) try{ LN0.addListener('localNotificationActionPerformed', onNotifAction); }catch{} }
async function nudgeChannel(LN){ await LN.createChannel({ id:NUDGE_CHANNEL, name:'Energy check-ins', description:'A few nudges a day to rate your energy', importance:3, vibration:false }); }
async function remChannel(LN){ await LN.createChannel({ id:REM_CHANNEL, name:'Task reminders', description:'Tells you when a task is about to start', importance:4, vibration:true }); }
async function remSync(){
  const LN = nativePlugin('LocalNotifications'); if (!LN) return;
  if (remBusy){ remAgain = true; return; }
  remBusy = true;
  try{
    const R = store.get('rem', { on:false, lead:0 });
    const ok = (R.on || store.get('enNudge', {}).on) && (await LN.checkPermissions()).display === 'granted';
    const plan = ok ? remPlan(R) : [], sig = plan.map(p => p.id + '@' + p.at.getTime() + p.title).join('|');
    if (sig === remSig) return;
    const snz = new Set(store.get('snz', []).filter(s => s.at > Date.now()).map(s => s.id));      // snoozed reminders stay
    const old = ((await LN.getPending()).notifications || []).filter(n => n.id !== REM_TEST_ID && !snz.has(n.id)).map(n => ({ id: n.id }));
    if (old.length) await LN.cancel({ notifications: old });
    if (plan.length){
      await remChannel(LN); await remActions(LN); if (plan.some(p => p.en)) await nudgeChannel(LN);
      await LN.schedule({ notifications: plan.map(p => p.en
        ? { id: p.id, title: p.title, body: p.body, channelId: NUDGE_CHANNEL, extra: { en: 1, ds: p.ds }, schedule: { at: p.at, allowWhileIdle: true } }
        : { id: p.id, title: p.title, body: p.body, channelId: REM_CHANNEL, actionTypeId: REM_ACTIONS, extra: { ds: p.ds, rid: p.rid, t: p.t }, schedule: { at: p.at, allowWhileIdle: true } }) });
    }
    remSig = sig;
  }catch(err){ console.warn('Yoteii reminders:', err); }
  finally{ remBusy = false; if (remAgain){ remAgain = false; remSoon(); } }
}
function nudgeBlock(){
  const on = !!store.get('enNudge', {}).on && remNative.perm === 'granted';
  return '<p class="tplRow">Energy check-ins</p><p class="wn">' + (on ? 'On. ' : 'Off. ') + 'A gentle nudge three times a day, at different times, to rate your energy from 1 to 5. A week or two of ratings is what lets My rhythm learn when you peak. Nudges skip times near a rating you already made and stop before your sleep cap.</p><div class="ea"><button id="nudgeToggle">' + (on ? 'Turn off' : 'Turn on') + '</button></div>';
}
function remCard(){
  const R = store.get('rem', { on:false, lead:0 }), has = 'Notification' in window, perm = has ? Notification.permission : 'unsupported', on = R.on && perm === 'granted';
  const leadSel = '<div class="capRow"><label for="remLead">Remind me</label><select id="remLead">' + [[0, 'At start'], [5, '5 min before'], [10, '10 min before']].map(o => '<option value="' + o[0] + '"' + (R.lead === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>';
  if (IS_NATIVE){
    const p = remNative.perm, nOn = R.on && p === 'granted';
    const st = p === 'denied' ? 'Notifications are blocked. Turn them on for Yoteii in Android Settings, under Apps, Yoteii, Notifications.' : nOn ? 'Reminders are on.' : 'Reminders are off.';
    const ex = nOn && remNative.exact === 'denied' ? '<p class="wn">For reminders on the exact minute, allow "Alarms &amp; reminders" for Yoteii. Without it Android can delay them by a few minutes.</p><div class="ea"><button id="remExact">Allow exact timing</button></div>' : '';
    return '<h2>Reminders</h2><p class="wn">' + st + '</p><p class="wn">Yoteii sets reminders for today and the next two days with your phone\'s alarm system, so they fire even when the app is closed. If some do not show up, allow notifications and unrestricted battery use for Yoteii in Android Settings.</p><p class="wn">Tasks in a part of the day where you have not chosen Home, School or Away get no reminders. Set your Usual days under Schedule so coming days are ready.</p>' + ex + leadSel + '<div class="ea"><button id="remToggle">' + (nOn ? 'Turn off' : 'Turn on') + '</button><button id="remTest">Send test</button></div>' + nudgeBlock();
  }
  const state = !has ? 'Notifications are not available in this browser. On iPhone, add Yoteii to your Home Screen first.' : perm === 'denied' ? 'Notifications are blocked. Allow them for this site in your browser settings.' : on ? 'Reminders are on.' : 'Reminders are off.';
  return '<h2>Reminders</h2><p class="wn">' + state + '</p><p class="wn">They only fire while Yoteii is open or running in the background, and phones may pause web apps. Keep Yoteii open if timing matters.</p><div class="capRow"><label for="remLead">Remind me</label><select id="remLead">' + [[0, 'At start'], [5, '5 min before'], [10, '10 min before']].map(o => '<option value="' + o[0] + '"' + (R.lead === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div><div class="ea"><button id="remToggle">' + (on ? 'Turn off' : 'Turn on') + '</button><button id="remTest">Send test</button></div>';
}
async function notify(title, body, tag){
  try{
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.showNotification){ await reg.showNotification(title, { body, tag, icon:'./assets/icon-192.png', badge:'./assets/icon-192.png', vibrate:[120, 60, 120] }); return; }
  }catch{}
  try{ new Notification(title, { body, tag, icon:'./assets/icon-192.png' }); }catch{}
}
function remCheck(){
  const R = store.get('rem', { on:false, lead:0 });
  if (IS_NATIVE || !R.on || !('Notification' in window) || Notification.permission !== 'granted') return;
  const ds = todayStr(), sv = { wake, day, done };
  let rows = [], dn = [];
  try{ loadDay(ds); rows = build(new Date().getDay()).rows; dn = done.ids.slice(); }
  finally{ wake = sv.wake; day = sv.day; done = sv.done; }
  const sent = store.get('remSent', null), S = sent && sent.d === ds ? sent : { d:ds, ids:[] }, nm = nowM();
  let ch = false;
  rows.filter(r => r.use > 0 && !r.sug && !dn.includes(r.id)).forEach(r => {
    const key = r.id + '@' + r.start;
    if (nm >= r.start - R.lead && nm < r.start + 3 && !S.ids.includes(key)){
      S.ids.push(key); ch = true;
      notify(R.lead ? r.t + ' in ' + R.lead + ' min' : 'Time for ' + r.t, range(r.start, r.end), key);
    }
  });
  if (ch) store.set('remSent', S);
}
setInterval(remCheck, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible'){ remCheck(); if (IS_NATIVE){ remNativeState(); remSoon(); autoBackupMaybe(); } } });
if (IS_NATIVE){ remNativeState(); remSoon(true); }
$('#tab-settings').insertAdjacentHTML('beforeend',
  '<div class="sleep" id="remCard">' + remCard() + '</div>' +
  '<div class="sleep"><h2>Routine templates</h2><p class="wn">Start from a ready-made routine, then edit it however you like.</p>' +
  Object.keys(TPL).map(l => '<p class="tplRow">' + TPL[l].label + '</p><div class="ea">' + Object.keys(TPL[l].sets).map(n => '<button data-tpl="' + l + '|' + n + '">' + n + '</button>').join('') + '</div>').join('') + '</div>');
$('#tab-settings').addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.tpl){ const [l, n] = t.dataset.tpl.split('|'); applyTpl(l, n); return; }
  if (t.id === 'remToggle'){
    const R = store.get('rem', { on:false, lead:0 });
    if (R.on) R.on = false;
    else if (IS_NATIVE){
      const LN = nativePlugin('LocalNotifications');
      try{ let p = await LN.checkPermissions(); if (p.display !== 'granted') p = await LN.requestPermissions(); R.on = p.display === 'granted'; }catch{ R.on = false; }
    }
    else if ('Notification' in window){ const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); R.on = p === 'granted'; }
    store.set('rem', R);
    if (IS_NATIVE){ await remNativeState(); remSoon(true); } else $('#remCard').innerHTML = remCard();
  }
  if (t.id === 'nudgeToggle'){
    const N = { ...store.get('enNudge', {}) };
    if (N.on) N.on = false;
    else if (IS_NATIVE){
      const LN = nativePlugin('LocalNotifications');
      try{ let p = await LN.checkPermissions(); if (p.display !== 'granted') p = await LN.requestPermissions(); N.on = p.display === 'granted'; }catch{ N.on = false; }
    }
    store.set('enNudge', N);
    if (IS_NATIVE){ await remNativeState(); remSoon(true); }
    return;
  }
  if (t.id === 'remExact'){ try{ await nativePlugin('LocalNotifications').changeExactNotificationSetting(); }catch{} }
  if (t.id === 'remTest' && IS_NATIVE){
    const LN = nativePlugin('LocalNotifications'), R = store.get('rem', { on:false, lead:0 });
    if (!LN || !R.on || remNative.perm !== 'granted'){ tell('Turn on reminders first.'); return; }
    try{
      await remChannel(LN);
      await LN.schedule({ notifications: [{ id:REM_TEST_ID, title:'Yoteii', body:'Reminders are working.', channelId:REM_CHANNEL, schedule:{ at:new Date(Date.now() + 3000), allowWhileIdle:true } }] });
      toast('Test reminder coming in a few seconds.');
    }catch{ tell('Could not send a test reminder.'); }
    return;
  }
  if (t.id === 'remTest'){
    if ('Notification' in window && Notification.permission === 'granted') notify('Yoteii', 'Reminders are working.', 'test');
    else tell('Turn on reminders first.');
  }
});
$('#tab-settings').addEventListener('change', e => {
  if (e.target.id !== 'remLead') return;
  const R = store.get('rem', { on:false, lead:0 }); R.lead = Number(e.target.value); store.set('rem', R); remSoon(true);
});

// ============================================================
// ONE-OFF TASKS + INBOX, PAST-DAY RECORDS, ENERGY, CALENDAR IMPORT,
// APPEARANCE, FIRST-RUN SETUP
// ============================================================
function snapMode(){ return viewDate < todayStr() && !day.live && !!store.get('hist', {})[viewDate]; }
function snapRows(){
  if (!snapMode()) return null;
  return (store.get('hist', {})[viewDate].rows || []).map(r => ({ id:r.id, t:r.t, w:r.w, md:r.md || undefined, start:r.s, end:r.e, use:r.u, d:r.u, sug:!!r.sug, post:r.w !== 'sleep', p:'core', snap:true }));
}
$('#liveBtn').addEventListener('click', () => { day.live = true; saveDay(); render(); });

function defaultWin(){
  if (viewDate !== todayStr()) return 'climb1';
  const WB = wins(), n = nowM() - wake;
  for (const k of Object.keys(WB)) if (n >= WB[k].from && n < WB[k].to) return k;
  return 'climb1';
}
$('#dnote').parentElement.insertAdjacentHTML('beforebegin', '<div class="ibx" id="inboxCard"></div>');
$('#tab-inbox').insertBefore($('#inboxCard'), $('#inCap'));
const IN_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7.5v9M7.5 12h9" stroke="var(--bg)"/></svg>';
const IN_TRAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" fill="currentColor" stroke="none" opacity=".25"/><path d="M4 13h4.5l1.2 2.2h4.6L15.5 13H20M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>';
const IN_CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
const IN_FLAG = (ICONS.flag || '').replace('class="pi"', 'class="ibFlag"');      // the flag comes from the app's own icon set
const IN_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
const IN_CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';
const IN_CHK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const IN_XI = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const IN_PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>';
const IN_ART = '<svg class="ibArt" viewBox="0 0 96 80" aria-hidden="true"><rect x="24" y="6" width="48" height="40" rx="6" style="fill:var(--card2)"/><rect x="14" y="18" width="68" height="34" rx="7" style="fill:var(--card);stroke:var(--line)"/><rect x="22" y="28" width="30" height="5" rx="2.5" style="fill:var(--card2)"/><rect x="22" y="38" width="20" height="4" rx="2" style="fill:var(--card2)"/><path d="M64 27v14" stroke-width="2" stroke-linecap="round" style="stroke:var(--imp)"/><path d="M64 27h11l-3 4.5 3 4.5H64z" style="fill:var(--imp)"/><path d="M4 42h22l5 9h34l5-9h22v26a8 8 0 0 1-8 8H12a8 8 0 0 1-8-8z" style="fill:var(--accent)"/></svg>';
let inPrefs = normalizePrefs(store.get('inboxPrefs', null)), inSortOpen = false, inFresh = null, inTap = { id:'', t:0 }, inDropAt = 0;
const inSetPrefs = p => { inPrefs = Object.assign({}, inPrefs, p); store.set('inboxPrefs', inPrefs); };

function ibRow(x){
  const ago = addedLabel(x), t = esc(x.t);
  return '<div class="ibRow' + (inFresh === x.id ? ' fresh' : '') + '" data-id="' + x.id + '"><div class="ibMain">' +
    '<div class="ibT">' + t + '</div>' + (x.note ? '<div class="ibNote">' + esc(x.note) + '</div>' : '') + (ago ? '<div class="ibAdded">' + esc(ago) + '</div>' : '') +
    '<button type="button" class="ibEd" data-ed="' + x.id + '">Edit ' + t + '</button></div>' +
    '<button type="button" class="ibBtn ibFl' + (x.imp ? ' on' : '') + '" data-imp="' + x.id + '" aria-pressed="' + (x.imp ? 'true' : 'false') + '" aria-label="' + (x.imp ? 'Not important: ' : 'Mark important: ') + t + '">' + IN_FLAG + '</button>' +
    '<button type="button" class="ibBtn ibSc" data-sch="' + x.id + '" aria-label="Schedule ' + t + '">' + IN_CAL + '</button></div>';
}
function drawInbox(){
  const el = $('#inboxCard'); if (!el) return;
  const list = store.get('inbox', []), n = list.length, bd = $('#inBadge'), tb = document.querySelector('.tabs [data-tab="inbox"]');
  if (bd){ bd.hidden = !n; bd.textContent = n > 99 ? '99+' : String(n); }
  if (tb) tb.setAttribute('aria-label', n ? 'Inbox, ' + n + (n === 1 ? ' task waiting' : ' tasks waiting') : 'Inbox');
  if (!n){
    el.innerHTML = '<div class="ibGhost" aria-hidden="true"><div><i></i><i></i></div><span>' + IN_FLAG + '</span><span>' + IN_CAL + '</span></div>' +
      '<div class="ibEmpty">' + IN_ART + '<h2>Your tasks will land here</h2><p class="wn">Add a thought now, schedule it whenever you\u2019re ready.</p><ul class="ibTips">' +
      '<li><span class="f">' + IN_FLAG + '</span>Flag what matters most</li><li><span>' + IN_CAL + '</span>Schedule it when you\u2019re ready</li><li><span>' + IN_PEN + '</span>Edit with a double-tap</li></ul></div>';
    return;
  }
  const st = stats(list), g = groups(list, inPrefs.s), onlyImp = inPrefs.f === 'imp', sortName = SORTS.find(s => s[0] === inPrefs.s)[1];
  const oldest = st.oldest === null ? '\u2013' : st.oldest === 0 ? 'Today' : st.oldest + 'd';
  let h = '<div class="ibSt"><div><b>' + st.total + '</b><span>Waiting</span></div><div class="w"><b>' + st.imp + '</b><span>Important</span></div><div><b>' + oldest + '</b><span>Oldest</span></div></div>' +
    '<div class="ibBar"><div class="ibSeg" role="group" aria-label="Filter"><button type="button" data-f="all" aria-pressed="' + !onlyImp + '"' + (onlyImp ? '' : ' class="on"') + '>All ' + st.total + '</button>' +
    '<button type="button" data-f="imp" aria-pressed="' + onlyImp + '"' + (onlyImp ? ' class="on"' : '') + '>Important ' + st.imp + '</button></div>' +
    '<button type="button" class="ibSort' + (inSortOpen ? ' op' : '') + '" data-sortbtn="1" aria-haspopup="menu" aria-expanded="' + inSortOpen + '"><span>Sort</span>' + esc(sortName) + IN_CHEV + '</button>' +
    (inSortOpen ? '<div class="ibPop" role="menu"><p>Sorts within each section</p>' + SORTS.map(([k, nm]) => '<button type="button" role="menuitemradio" aria-checked="' + (k === inPrefs.s) + '" data-s="' + k + '"' + (k === inPrefs.s ? ' class="on"' : '') + '>' + nm + (k === inPrefs.s ? IN_CHK : '') + '</button>').join('') + '</div>' : '') + '</div>';
  const sec = (name, items, key) => '<div class="ibSec"><span>' + name + '</span><span>' + items.length + '</span></div><div class="ibSheet" data-g="' + key + '">' + items.map(ibRow).join('') + '</div>';
  if (onlyImp) h += g.imp.length ? '<div class="ibSheet ibTop" data-g="imp">' + g.imp.map(ibRow).join('') + '</div>' : '<div class="ibNone"><b>Nothing flagged</b><p class="wn">Tap the flag on a task to keep it here.</p></div>';
  else h += (g.imp.length ? sec('Important', g.imp, 'imp') : '') + (g.rest.length ? sec('Later', g.rest, 'rest') : '');
  el.innerHTML = h + '<p class="ibHint">Double-tap a task to edit \u00b7 Hold to reorder</p>';
}
function inSchedule(id){
  const it = store.get('inbox', []).find(x => x.id === id); if (!it) return;
  openEd('oo', null, defaultWin()); $('#e_t').value = it.t; if (it.note) $('#e_details').value = it.note; cur.fromInbox = it.id;   // the note comes along as the task's details
}
function openInboxComposer(){ openQuickAdd(); }                      // "Add to inbox" from the + menu opens the same sheet
$('#inboxCard').addEventListener('click', e => {
  const b = e.target.closest('button'), wasOpen = inSortOpen;
  if (b && b.dataset.sortbtn){ inSortOpen = !inSortOpen; drawInbox(); return; }
  inSortOpen = false;
  if (b){
    if (b.dataset.s){ inSetPrefs({ s:b.dataset.s }); drawInbox(); }
    else if (b.dataset.f){ inSetPrefs({ f:b.dataset.f }); drawInbox(); }
    else if (b.dataset.imp){ const l = store.get('inbox', []), it = l.find(x => x.id === b.dataset.imp); if (it){ if (it.imp) delete it.imp; else it.imp = true; store.set('inbox', l); } drawInbox(); }
    else if (b.dataset.sch) inSchedule(b.dataset.sch);
    else if (b.dataset.ed) openQuickAdd(b.dataset.ed);
    else if (wasOpen) drawInbox();
    return;
  }
  const row = e.target.closest('.ibRow');
  if (row && Date.now() - inDropAt > 400){                         // a single tap does nothing; a second tap on the same task opens it
    const id = row.dataset.id, now = Date.now();
    if (inTap.id === id && now - inTap.t < 380){ inTap = { id:'', t:0 }; openQuickAdd(id); } else inTap = { id, t:now };
  }
  if (wasOpen) drawInbox();
});
document.addEventListener('click', e => { if (inSortOpen && !e.composedPath().includes($('#inboxCard'))){ inSortOpen = false; drawInbox(); } });   // composedPath: the tapped button may already have been redrawn

// ---- the capture bar: type, flag if it matters, send ----
let capImp = false;
$('#inCapF').innerHTML = IN_FLAG; $('#inCapGo').innerHTML = IN_UP;
function capFlag(on){ capImp = !!on; $('#inCapF').classList.toggle('on', capImp); $('#inCapF').setAttribute('aria-pressed', capImp ? 'true' : 'false'); }
function capSync(){ $('#inCapGo').disabled = !$('#inCapT').value.trim(); }
function capAdd(){
  const v = $('#inCapT').value.trim(); if (!v) return;
  const it = makeTask(v, { imp:capImp });
  store.set('inbox', insertNew(store.get('inbox', []), it));
  if (inPrefs.f === 'imp' && !it.imp) inSetPrefs({ f:'all' });      // so the new task is not hidden by the filter
  inFresh = it.id; $('#inCapT').value = ''; capFlag(false); capSync(); drawInbox();
  const r = document.querySelector('.ibRow[data-id="' + it.id + '"]'); if (r) r.scrollIntoView({ block:'nearest', behavior:'smooth' });
  setTimeout(() => { inFresh = null; }, 1600);
}
$('#inCapF').onclick = () => capFlag(!capImp);
$('#inCapGo').onclick = () => { capAdd(); $('#inCapT').focus(); };
$('#inCapT').addEventListener('input', capSync);
$('#inCapT').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); capAdd(); } });
capSync();

// ---- the add / edit sheet (the + menu opens it empty; double-tapping a task opens it filled) ----
let qaEditId = null, qaImp = false;
$('#qa_x').innerHTML = IN_XI; $('#qa_imp').innerHTML = IN_FLAG; $('#qa_sch').innerHTML = IN_CAL + 'Schedule';
function qaFlag(on){ qaImp = !!on; $('#qa_imp').classList.toggle('on', qaImp); $('#qa_imp').setAttribute('aria-pressed', qaImp ? 'true' : 'false'); }
function qaSync(){ $('#qa_ok').disabled = !$('#qa_t').value.trim(); }
function openQuickAdd(id){
  const it = id ? store.get('inbox', []).find(x => x.id === id) : null; qaEditId = it ? it.id : null;
  $('#qa_title').textContent = it ? 'Edit inbox task' : 'New inbox task'; $('#qa_ok').textContent = it ? 'Save' : 'Add';
  $('#qa_t').value = it ? it.t : ''; $('#qa_note').value = it && it.note ? it.note : ''; qaFlag(it && it.imp); qaSync();
  $('#qaDlg').classList.toggle('isEdit', !!it);
  $('#qaDlg').showModal(); if (!it){ $('#qa_t').focus(); setTimeout(() => $('#qa_t').focus(), 80); }
}
function qaSave(){
  const v = $('#qa_t').value.trim(); if (!v) return;
  const note = $('#qa_note').value.trim().slice(0, 300), l = store.get('inbox', []);
  if (qaEditId){
    const it = l.find(x => x.id === qaEditId);
    if (it){ it.t = v; if (note) it.note = note; else delete it.note; if (qaImp) it.imp = true; else delete it.imp; }
    store.set('inbox', l);
  } else { const it = makeTask(v, { note, imp:qaImp }); store.set('inbox', insertNew(l, it)); inFresh = it.id; setTimeout(() => { inFresh = null; }, 1600); }
  drawInbox(); $('#qaDlg').close();
}
$('#qa_ok').onclick = qaSave;
$('#qa_x').onclick = () => $('#qaDlg').close();
$('#qa_imp').onclick = () => qaFlag(!qaImp);
$('#qa_t').addEventListener('input', qaSync);
$('#qa_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); qaSave(); } });
$('#qaDlg').addEventListener('click', e => { if (e.target === $('#qaDlg')) $('#qaDlg').close(); });
$('#qa_sch').onclick = () => { const id = qaEditId; $('#qaDlg').close(); if (id) inSchedule(id); };
$('#qa_del').onclick = () => { const id = qaEditId, _s = grab(); $('#qaDlg').close(); if (!id) return; store.set('inbox', store.get('inbox', []).filter(x => x.id !== id)); drawInbox(); showUndo('Removed from inbox', _s); };

// ---- hold a task to pick it up, drag it up or down inside its section ----
(function(){
  const card = $('#inboxCard');
  let hold = null, drag = null, sx = 0, sy = 0, ly = 0;
  const stop = () => { clearTimeout(hold); hold = null; };
  function lift(row, pid){
    drag = { row, box:row.parentElement, g:row.parentElement.dataset.g, was:[...row.parentElement.children].map(r => r.dataset.id).join() };
    row.classList.add('lift'); document.body.classList.add('ibDrag');
    try{ row.setPointerCapture(pid); }catch{}
    try{ navigator.vibrate && navigator.vibrate(12); }catch{}
    requestAnimationFrame(tick);
  }
  function tick(){
    if (!drag) return;
    if (ly < 100) scrollBy(0, -12); else if (ly > innerHeight - 170) scrollBy(0, 12);
    const others = [...drag.box.children].filter(r => r !== drag.row); let before = null;
    for (const r of others){ const bb = r.getBoundingClientRect(); if (ly < bb.top + bb.height / 2){ before = r; break; } }
    if (before !== drag.row.nextElementSibling) drag.box.insertBefore(drag.row, before);
    requestAnimationFrame(tick);
  }
  function drop(){
    const d = drag; drag = null; document.body.classList.remove('ibDrag'); d.row.classList.remove('lift'); inDropAt = Date.now();
    const ids = [...d.box.children].map(r => r.dataset.id);
    if (ids.join() === d.was){ drawInbox(); return; }
    store.set('inbox', applyOrder(store.get('inbox', []), inPrefs.s, d.g, ids));
    if (inPrefs.s !== 'manual'){ inSetPrefs({ s:'manual' }); toast('Sort set to Manual'); }
    drawInbox();
  }
  card.addEventListener('pointerdown', e => {
    if ((e.button || 0) > 0 || e.target.closest('button')) return;
    const row = e.target.closest('.ibRow'); if (!row) return;
    sx = ly = e.clientY; sx = e.clientX; sy = e.clientY; ly = e.clientY; stop();
    hold = setTimeout(() => { hold = null; lift(row, e.pointerId); }, 380);
  });
  card.addEventListener('pointermove', e => { ly = e.clientY; if (hold && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) stop(); });
  ['pointerup', 'pointercancel'].forEach(t => card.addEventListener(t, () => { stop(); if (drag) drop(); }));
  card.addEventListener('contextmenu', e => { if (e.target.closest('.ibRow')) e.preventDefault(); });
  document.addEventListener('touchmove', e => { if (drag && e.cancelable) e.preventDefault(); }, { passive:false });
})();

// ---- To-do tab: lists as chips, star, due date, subtasks, drag to reorder, sort, show done ----
let tdSel = 'all';       // the chip that is selected: 'all', a smart view ('sv:today' | 'sv:upcoming' | 'sv:starred'), or a list id
let tdCalMonth = null, tdCalDay = null;   // calendar view: the month shown (YYYY-MM-01) and the selected day
const TD_SMART = [['sv:today', 'Today'], ['sv:upcoming', 'Upcoming'], ['sv:starred', 'Starred']];
const tdIsSmart = s => String(s).startsWith('sv:');
function tdListSel(ls){ return (ls || tdLists()).some(z => z.id === tdSel) ? tdSel : 'main'; }   // the list a new to-do goes into
function tdName(sel, ls){ const s = TD_SMART.find(z => z[0] === sel); return s ? s[1] : ((ls || tdLists()).find(z => z.id === sel) || { name:'Tasks' }).name; }
function tdIn(x, sel, ls){        // is this to-do part of the selected view?
  const td = todayStr();
  if (sel === 'all') return true;
  if (sel === 'sv:today') return !!x.due && x.due <= td;       // today and overdue
  if (sel === 'sv:upcoming') return !!x.due && x.due > td;
  if (sel === 'sv:starred') return !!x.star;
  return tdListOf(x, ls) === sel;
}
const TD_REP = { d:'Daily', wd:'Weekdays', w:'Weekly', m:'Monthly', y:'Yearly' };
const TD_LOOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3M20 5H8a4 4 0 0 0-4 4v1M7 22l-3-3 3-3M4 19h12a4 4 0 0 0 4-4v-1"/></svg>';
function tdNext(x){        // the next due date of a repeating to-do: after its current date, and never before today
  const td = todayStr(); let d = parseDay(x.due), n = 0;
  const step = () => {
    const y = d.getFullYear(), mo = d.getMonth(), dd = d.getDate();
    if (x.rep === 'd') d = new Date(y, mo, dd + 1);
    else if (x.rep === 'wd'){ d = new Date(y, mo, dd + 1); while (d.getDay() === 0 || d.getDay() === 6) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); }
    else if (x.rep === 'w') d = new Date(y, mo, dd + 7);
    else if (x.rep === 'm') d = new Date(y, mo + 1, Math.min(dd, new Date(y, mo + 2, 0).getDate()));
    else d = new Date(y + 1, mo, Math.min(dd, new Date(y + 1, mo + 1, 0).getDate()));
  };
  do { step(); } while (isoLocal(d) < td && ++n < 800);
  return isoLocal(d);
}
function tdAdvance(it){ it.due = tdNext(it); if (Array.isArray(it.steps)) it.steps.forEach(s => { s.d = false; }); }   // done once: on to the next date
const tdOpen = new Set();   // to-dos whose subtasks and note are showing
const IN_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>';
const TD_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>';
const TD_STEP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/></svg>';
const TD_NOTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
function tdLists(){ const s = store.get('todoLists', null), a = Array.isArray(s) ? s.filter(x => x && x.id).slice() : []; if (!a.some(x => x.id === 'main')) a.unshift({ id:'main', name:'Tasks' }); return a; }
function tdListOf(x, ls){ return x.l && (ls || tdLists()).some(z => z.id === x.l) ? x.l : 'main'; }
function tdPrefs(){ const p = Object.assign({ sort:'date', done:true, hide:[], mode:'list' }, store.get('todoPrefs', {})); if (p.sort === 'due') p.sort = 'date'; return p; }
function tdSetPref(k, v){ const p = store.get('todoPrefs', {}); p[k] = v; store.set('todoPrefs', p); }
const tdMin = s => { const z = /^(\d{2}):(\d{2})$/.exec(s || ''); return z ? +z[1] * 60 + +z[2] : null; };
function tdDue(x, bare){        // the due label, and whether the to-do is overdue. bare: no "Overdue" prefix (the section already says it)
  if (!x.due) return null;
  const td = todayStr(), mins = tdMin(x.dt), late = isOverdue(x, td, nowM());
  return { late, today:x.due === td, text:(late && !bare ? 'Overdue \u00b7 ' : '') + tdDay(x.due) + (mins !== null ? ', ' + fmt(mins).join(' ') : '') };
}
const TD_COLORS = ['#5e96cb', '#22c55e', '#f59e0b', '#ec4899', '#a78bfa', '#14b8a6'];
const TD_NEW = ['#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#2dd4bf', '#fb923c', '#f87171', '#60a5fa'];   // colours offered first to new lists and tags
function tdListColor(l, i){ return (l && l.c) || (l && l.id === 'main' ? '' : TD_COLORS[i % TD_COLORS.length]) || ''; }   // '' means the app accent
function tdLc(id, lists){ const i = Math.max(0, lists.findIndex(z => z.id === id)); return tdListColor(lists[i], i) || 'var(--accent)'; }
let tdTags = [];        // the tags the list is filtered by: a to-do must have all of them
const TD_CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
const TD_SECS = [['late', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['upcoming', 'Upcoming'], ['none', 'No date']];
let tdTagRow = false;     // the tag filter row is open
let tdFresh = null;       // a to-do that was just added (it flashes once)
let tdCapKey = '', tdCapOv = {};      // the composer: which view it was set up for, and what the person changed since
const TD_ICO = d => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
const TD_HASH = TD_ICO('<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>');
const TD_LISTI = TD_ICO('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>');
const TD_TL = TD_ICO('<path d="M4 6h16M4 12h10M4 18h14"/>');
const TD_PLUS = TD_ICO('<path d="M12 5v14M5 12h14"/>');
const TD_ART = '<svg class="ibArt" viewBox="0 0 96 80" aria-hidden="true"><rect x="26" y="4" width="46" height="44" rx="7" style="fill:var(--card2)"/><rect x="14" y="12" width="68" height="62" rx="9" style="fill:var(--card);stroke:var(--line)"/><circle cx="29" cy="30" r="6" style="fill:var(--accent)"/><path d="M26 30l2.2 2.2 3.8-4.2" style="fill:none;stroke:var(--bg);stroke-width:2;stroke-linecap:round;stroke-linejoin:round"/><rect x="41" y="27" width="30" height="5" rx="2.5" style="fill:var(--card2)"/><circle cx="29" cy="48" r="6" style="fill:none;stroke:var(--line);stroke-width:2"/><rect x="41" y="45" width="22" height="5" rx="2.5" style="fill:var(--card2)"/><circle cx="29" cy="64" r="6" style="fill:none;stroke:var(--line);stroke-width:2"/><rect x="41" y="61" width="28" height="5" rx="2.5" style="fill:var(--card2)"/></svg>';
function tdDay(iso){        // Today, Tomorrow, Yesterday, or Thu, Oct 22
  const td = todayStr();
  return iso === td ? 'Today' : iso === addDays(td, 1) ? 'Tomorrow' : iso === addDays(td, -1) ? 'Yesterday'
    : parseDay(iso).toLocaleDateString(undefined, Object.assign({ weekday:'short', month:'short', day:'numeric' }, iso.slice(0, 4) !== td.slice(0, 4) ? { year:'numeric' } : {}));
}
function tdDayShort(iso){ const td = todayStr(); return iso === td || iso === addDays(td, 1) || iso === addDays(td, -1) ? tdDay(iso) : parseDay(iso).toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
function tdDayLong(iso){ const a = tdDay(iso); return /^(Today|Tomorrow|Yesterday)$/.test(a) ? a + ', ' + parseDay(iso).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : a; }
function tdPut(it, v){      // a date, with its time and repeat. A time or repeat needs a date
  if (v.due){ it.due = v.due; if (v.dt) it.dt = v.dt; else delete it.dt; if (v.rep) it.rep = v.rep; else delete it.rep; }
  else { delete it.due; delete it.dt; delete it.rep; }
}
function tdCapDef(){        // what a new to-do starts as, from the view you are in
  const td = todayStr();
  if (tdPrefs().mode === 'cal' && !tdIsSmart(tdSel)) return { due:tdCalDay || td, star:false };
  return tdSel === 'sv:today' ? { due:td, star:false } : tdSel === 'sv:upcoming' ? { due:addDays(td, 1), star:false } : tdSel === 'sv:starred' ? { due:'', star:true } : { due:'', star:false };
}
function tdCapState(){
  const d = tdCapDef(), key = tdSel + '|' + tdPrefs().mode + '|' + tdCalDay + '|' + tdTags.join(',');
  if (key !== tdCapKey){ tdCapKey = key; tdCapOv = {}; }
  const pick = k => tdCapOv[k] !== undefined ? tdCapOv[k] : (d[k] || (k === 'star' ? false : ''));
  return { due:pick('due'), dt:tdCapOv.dt || '', rep:tdCapOv.rep || '', star:pick('star') };
}
function tdBadge(){         // the red number on the To-do tab: how many are overdue
  const n = overdueCount(store.get('todos', []), todayStr(), nowM()), b = $('#tdBadge'), tb = document.querySelector('.tabs [data-tab="todo"]');
  if (b){ b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); }
  if (tb) tb.setAttribute('aria-label', n ? 'To-do, ' + n + ' overdue' : 'To-do');
}
function drawTodoCap(lists){
  const st = tdCapState(), ch = [], L = lists.find(x => x.id === tdSel), tg = store.get('todoTags', []);
  if (L) ch.push('<span class="tdCapC" style="--lc:' + tdLc(L.id, lists) + '"><i></i>' + esc(L.name) + '</span>');
  const t1 = tdTags.length ? tg.find(t => t.id === tdTags[0]) : null;
  if (t1) ch.push('<span class="tdCapC tg" style="--tc:' + (t1.c || 'var(--accent)') + '">#' + esc(t1.name) + (tdTags.length > 1 ? ' +' + (tdTags.length - 1) : '') + '</span>');
  $('#tdCapCh').innerHTML = ch.join('');
  const d = $('#tdCapD'), lab = st.due ? tdDayShort(st.due) : '';
  d.className = st.due ? 'tdCapDc' : 'tdCapB';
  d.innerHTML = TD_CAL + (st.due ? '<span>' + esc(lab) + '</span>' : '');
  d.setAttribute('aria-label', st.due ? 'Due ' + lab + '. Change the date' : 'Set a due date');
  const s = $('#tdCapS'); s.classList.toggle('on', !!st.star); s.setAttribute('aria-pressed', st.star ? 'true' : 'false');
}
function drawTodo(){
  const el = $('#todoCard'); if (!el) return;
  const tgAll = store.get('todoTags', []); tdTags = tdTags.filter(id => tgAll.some(t => t.id === id));
  const TGM = {}; tgAll.forEach(t => { TGM[t.id] = t; });
  const lists = tdLists(); if (tdSel !== 'all' && !tdIsSmart(tdSel) && !lists.some(x => x.id === tdSel)) tdSel = 'all';
  const P = tdPrefs(), all = store.get('todos', []), tagOk = x => tdTags.every(id => (x.tags || []).includes(id));
  if (P.mode === 'cal' && tdIsSmart(tdSel)) tdSel = 'all';       // the smart views are lists of dates, so they have no calendar
  const view = all.filter(x => tdIn(x, tdSel, lists) && tagOk(x)), isList = lists.some(x => x.id === tdSel), showCal = P.mode === 'cal';
  tdBadge();
  // header: tag filter and the list / calendar switch
  const seg = (m, ic, lab) => '<button type="button" data-vm="' + m + '" aria-pressed="' + ((m === 'cal') === showCal) + '" aria-label="' + lab + '">' + ic + '</button>';
  $('#tdHdr').innerHTML = '<button type="button" class="tdHb' + (tdTags.length || tdTagRow ? ' on' : '') + '" id="tdHash" aria-pressed="' + !!(tdTags.length || tdTagRow) + '" aria-label="' + (tdTags.length ? 'Tags, ' + tdTags.length + ' selected' : 'Filter by tag') + '">' + TD_HASH + (tdTags.length ? '<b>' + tdTags.length + '</b>' : '') + '</button>' +
    '<div class="tdSeg" role="group" aria-label="View">' + seg('list', TD_LISTI, 'List view') + seg('cal', TD_CAL, 'Calendar view') + '</div>';
  // chips: smart views (not in the calendar), then the lists
  const cnt = sel => all.filter(z => !z.done && tdIn(z, sel, lists) && tagOk(z)).length;
  const chip = (id, inner, extra) => '<button type="button" role="tab" class="tdChip' + (id === tdSel ? ' on' : '') + '" data-ls="' + id + '" aria-selected="' + (id === tdSel) + '"' + (extra || '') + '>' + inner + '</button>';
  const smart = [chip('all', 'All')].concat(showCal ? [] : TD_SMART.map(z => { const n = cnt(z[0]); return chip(z[0], z[1] + (n ? '<span class="tdCn">' + n + '</span>' : '')); }));
  const lch = lists.map(l => chip(l.id, '<i class="tdDot"></i>' + esc(l.name), ' style="--lc:' + tdLc(l.id, lists) + '"'));
  const plus = '<button type="button" class="tdChip tdAddL" data-ls="+" aria-label="New list">+</button>';
  let chips;
  if (showCal) chips = '<div class="tdChipsW"><div class="tdChips" role="tablist" aria-label="Lists">' + smart.concat(lch).join('') + '</div>' + plus + '</div>';
  else {
    chips = '<div class="tdChipsW"><div class="tdChips" role="tablist" aria-label="Views">' + smart.join('') + '</div></div>';
    if (lists.length > 1) chips += '<div class="tdChipsW tdLs"><div class="tdChips" role="tablist" aria-label="Lists">' + lch.join('') + '</div>' + plus + '</div>';
    else chips += '<div class="tdChipsW tdLs"><div class="tdChips"><button type="button" class="tdChip tdNewL" data-ls="+">+ New list</button></div></div>';
  }
  const tgRow = tdTagRow || tdTags.length ? '<div class="tgFilter"><span class="tgLab">Tags</span>' + (tgAll.length ? tgAll.map(t => '<button type="button" class="tgChip' + (tdTags.includes(t.id) ? ' on' : '') + '" data-tf="' + t.id + '" aria-pressed="' + tdTags.includes(t.id) + '" style="--tc:' + (t.c || 'var(--accent)') + '">#' + esc(t.name) + '</button>').join('') : '<span class="tgNone">No tags yet</span>') + '<button type="button" class="tdLink" data-tn="1">+ New</button>' + (tdTags.length === 1 ? '<button type="button" class="tdLink" data-te="1">Edit</button>' : '') + (tdTags.length ? '<button type="button" class="tdLink" data-tc="1">Clear</button>' : '') + '</div>' : '';
  drawTodoCap(lists);
  if (!view.length && !showCal){
    let em;
    if (tdTags.length) em = '<div class="ibEmpty tdEm"><div class="tdEmI">' + TD_HASH + '</div><h2>No matches</h2><p class="wn">No to-dos have all of the selected tags here.</p></div>';
    else if (!all.length && tdSel === 'all') em = '<div class="ibGhost" aria-hidden="true"><div><i></i><i></i></div><span>' + IN_CHECK + '</span><span>' + TD_STAR + '</span></div>' +
      '<div class="ibEmpty">' + TD_ART + '<h2>Your to-dos will live here</h2><p class="wn">Things with a deadline or a plan go here. Loose thoughts can stay in your Inbox.</p><ul class="ibTips">' +
      '<li><span>' + IN_CAL + '</span>Add a date and it shows up in Today</li><li><span class="s">' + TD_STAR + '</span>Star what matters most</li><li><span>' + TD_TL + '</span>Plan it on your Timeline</li></ul></div>';
    else if (tdIsSmart(tdSel)){
      const T = { 'sv:today':['Nothing due today', 'You are clear for today.'], 'sv:upcoming':['Nothing coming up', 'To-dos with a later date show up here.'], 'sv:starred':['No starred to-dos', 'Tap the star on a to-do to keep it here.'] }[tdSel];
      em = '<div class="ibEmpty tdEm"><div class="tdEmI">' + IN_CHECK + '</div><h2>' + T[0] + '</h2><p class="wn">' + T[1] + '</p></div>';
    } else {
      const L = lists.find(x => x.id === tdSel);
      em = '<div class="ibEmpty tdEm"><div class="tdEmI list" style="--lc:' + tdLc(tdSel, lists) + '">' + TD_LISTI + '</div><h2>' + esc(tdName(tdSel, lists)) + ' is empty</h2><p class="wn">Add a to-do and it lands in ' + esc(tdName(tdSel, lists)) + '.</p><button type="button" class="tdLink" id="tdListEdit">Edit list</button></div>';
    }
    el.innerHTML = chips + tgRow + em; return;
  }
  const td = todayStr(), tmr = addDays(td, 1);
  const isLate = x => { const d = tdDue(x); return !!(d && d.late); };
  const bucket = x => !x.due ? 'none' : isLate(x) ? 'late' : x.due === td ? 'today' : x.due === tmr ? 'tomorrow' : x.due > tmr ? 'upcoming' : 'late';
  const open = view.filter(x => !x.done), dn = view.filter(x => x.done);
  const dueKey = x => (x.due || '9999-99-99') + ' ' + (x.dt || '99:99');
  const starFirst = (a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0);
  const sortFn = P.sort === 'az' ? (a, b) => a.t.localeCompare(b.t) : P.sort === 'new' ? (a, b) => String(b.id).localeCompare(String(a.id)) : null;
  const arrange = a => sortFn ? a.slice().sort(sortFn) : a;
  const row = (x, canDrag, bare) => {
    const lc = x.c || tdLc(tdListOf(x, lists), lists);        // a to-do's own colour wins over its list's
    const di = tdDue(x, bare), st = Array.isArray(x.steps) ? x.steps : [], nd = st.filter(s => s.d).length, ex = tdOpen.has(x.id) && (st.length || x.note);
    const tgs = (x.tags || []).filter(id => TGM[id]).map(id => '<span class="tdTg" style="--tc:' + (TGM[id].c || 'var(--accent)') + '">#' + esc(TGM[id].name) + '</span>').join('');
    const exBtn = (ic, txt, lab) => '<button type="button" class="tdMb" data-ex="' + x.id + '" aria-expanded="' + !!ex + '" aria-label="' + lab + '">' + ic + txt + '</button>';
    const dueEl = di ? (x.done ? '<span class="tdDue">' + esc(di.text) + '</span>' : '<button type="button" class="tdDue' + (di.late ? ' late' : di.today ? ' today' : '') + '" data-dp="' + x.id + '" aria-label="Due ' + esc(di.text) + '. Change the date">' + esc(di.text) + '</button>') : '';
    const meta = dueEl + (x.rep && TD_REP[x.rep] ? '<span class="tdRep">' + TD_LOOP + TD_REP[x.rep] + '</span>' : '') +
      (st.length ? exBtn(TD_STEP, nd + '/' + st.length, 'Subtasks, ' + nd + ' of ' + st.length + ' done') : '') + (x.note ? exBtn(TD_NOTE, '', 'Note') : '') + tgs;
    const exp = ex ? '<div class="tdExp">' + st.map((s, i) => '<button type="button" class="tdStp' + (s.d ? ' done' : '') + '" data-sg="' + x.id + '" data-si="' + i + '"><span class="tdSc"></span><span>' + esc(s.t) + '</span></button>').join('') + (x.note ? '<div class="tdNote">' + esc(x.note) + '</div>' : '') + '</div>' : '';
    return '<div class="tdItem' + (x.done ? ' done' : '') + (tdFresh === x.id ? ' fresh' : '') + '" data-id="' + x.id + '" style="--lc:' + lc + '"><button class="tdChk" data-tg="' + x.id + '" aria-pressed="' + (x.done ? 'true' : 'false') + '" aria-label="' + (x.done ? 'Mark not done: ' : 'Mark done: ') + esc(x.t) + '"></button>' +
      '<div class="tdMain"><button class="tdTxt" data-ed="' + x.id + '">' + (x.ic ? '<i class="tdIc" style="color:' + lc + '">' + iconMarkup(x.ic) + '</i>' : '') + esc(x.t) + '</button>' + (meta ? '<div class="tdMeta">' + meta + '</div>' : '') + exp + '</div>' +
      ((!x.done || (canDrag && !x.done)) ? '<div class="tdSide">' + (x.done ? '' : '<button class="tdStar' + (x.star ? ' on' : '') + '" data-st="' + x.id + '" aria-pressed="' + (x.star ? 'true' : 'false') + '" aria-label="' + (x.star ? 'Remove star: ' : 'Star: ') + esc(x.t) + '">' + TD_STAR + '</button>') + (!x.done && canDrag ? '<span class="tdH" aria-label="Drag to reorder" title="Drag to reorder">&#8942;&#8942;</span>' : '') + '</div>' : '') + '</div>';
  };
  const grp = (a, g, canDrag, bare) => a.length ? '<div class="tdList" data-grp="' + g + '">' + a.map(x => row(x, canDrag, bare)).join('') + '</div>' : '';
  const SORTN = { date:'By date', mine:'My order', az:'A to Z', 'new':'Newest first' };
  const opt = (v, t) => '<option value="' + v + '"' + (P.sort === v ? ' selected' : '') + '>' + t + '</option>';
  const edl = isList ? '<button type="button" class="tdEdl" id="tdListEdit" aria-label="Edit list"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' : '';
  if (showCal){ el.innerHTML = chips + tgRow + tdCalHtml(view, grp, lists, edl); return; }
  const bar = '<div class="tdBar"><label class="ibSort tdSortB"><span>Sort</span>' + SORTN[P.sort] + IN_CHEV + '<select id="td_sort" class="tdOv" aria-label="Sort by">' + opt('date', 'By date') + opt('mine', 'My order') + opt('az', 'A to Z') + opt('new', 'Newest first') + '</select></label>' + edl + '</div>';
  let body = '';
  if (P.sort === 'date'){
    const hide = new Set(P.hide || []);
    TD_SECS.forEach(([k, label]) => {
      const items = open.filter(x => bucket(x) === k).sort((a, b) => starFirst(a, b) || (k === 'none' ? 0 : dueKey(a).localeCompare(dueKey(b))));
      if (!items.length) return;
      const o = !hide.has(k);
      body += '<section class="tdSec' + (k === 'late' ? ' late' : '') + '"><button type="button" class="tdSecH" data-sec="' + k + '" aria-expanded="' + o + '"><span>' + label + '</span><span class="tdR"><span class="tdN">' + items.length + '</span><svg viewBox="0 0 24 24" aria-hidden="true" class="' + (o ? 'open' : '') + '"><path d="M6 9l6 6 6-6"/></svg></span></button>' + (o ? grp(items, k, true, true) : '') + '</section>';
    });
  } else {
    const drag = P.sort === 'mine';
    body = grp(arrange(open.filter(x => x.star)), 'star', drag) + grp(arrange(open.filter(x => !x.star && isLate(x))), 'late', drag) + grp(arrange(open.filter(x => !x.star && !isLate(x))), 'norm', drag);
  }
  const caught = !open.length && dn.length ? '<div class="tdCaught"><span>' + IN_CHK + '</span><div><b>All caught up</b><small>Nothing left to do here.</small></div></div>' : '';
  el.innerHTML = chips + tgRow + bar + body + caught +
    (dn.length ? '<p class="tdSub"><button type="button" id="tdDoneTog" aria-expanded="' + P.done + '">Done (' + dn.length + ')<svg viewBox="0 0 24 24" aria-hidden="true" class="' + (P.done ? 'open' : '') + '"><path d="M6 9l6 6 6-6"/></svg></button><button type="button" id="tdClear">Clear done</button></p>' + (P.done ? grp(arrange(dn), 'done', false) : '') : '');
}
function tdCalHtml(view, grp, lists, edl){
  const td = todayStr(), week = !!tdPrefs().calWeek;
  if (!tdCalDay) tdCalDay = td;
  if (!tdCalMonth) tdCalMonth = tdCalDay.slice(0, 7) + '-01';
  const byDay = {}; view.forEach(x => { if (x.due) (byDay[x.due] = byDay[x.due] || []).push(x); });
  const cell = iso => {
    const its = byDay[iso] || [], open = its.filter(x => !x.done);
    const dots = open.slice(0, 3).map(x => '<i style="background:' + (x.due < td ? 'var(--bad)' : x.c || tdLc(tdListOf(x, lists), lists)) + '"></i>').join('');
    return '<button type="button" class="calC' + (iso === td ? ' today' : '') + (iso === tdCalDay ? ' sel' : '') + '" data-cd="' + iso + '" aria-pressed="' + (iso === tdCalDay) + '" aria-label="' + esc(parseDay(iso).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })) + ', ' + open.length + ' to do"><b>' + +iso.slice(8) + '</b><span class="calD">' + dots + '</span></button>';
  };
  let cells; const mDate = parseDay(week ? tdCalDay : tdCalMonth);
  if (week) cells = weekDays(tdCalDay).map(cell);
  else { const g = monthGrid(tdCalMonth); cells = Array.from({ length:g.lead }, () => '<span class="calC off"></span>').concat(g.days.map(cell)); }
  const head = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => '<span>' + n + '</span>').join('');
  const day = byDay[tdCalDay] || [], o = day.filter(x => !x.done), dn = day.filter(x => x.done);
  const chev = d => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  return '<div class="calHead"><h2>' + esc(mDate.toLocaleDateString(undefined, { month:'long', year:'numeric' })) + '</h2><button type="button" class="tdLink calTd" data-cm="0">Today</button><button type="button" class="calNav" data-cm="-1" aria-label="' + (week ? 'Previous week' : 'Previous month') + '">' + chev('M15 6l-6 6 6 6') + '</button><button type="button" class="calNav" data-cm="1" aria-label="' + (week ? 'Next week' : 'Next month') + '">' + chev('M9 6l6 6-6 6') + '</button>' + (edl || '') + '</div>' +
    '<div class="calGrid calWd" aria-hidden="true">' + head + '</div><div class="calGrid' + (week ? ' wk' : '') + '">' + cells.join('') + '</div>' +
    '<button type="button" class="calHandle" data-cw="1" aria-expanded="' + !week + '" aria-label="' + (week ? 'Show the whole month' : 'Show this week only') + '"><span></span></button>' +
    '<div class="calDay"><div class="calDayH"><b>' + esc(parseDay(tdCalDay).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' })) + '</b><span>' + (o.length ? '· ' + o.length + ' to do' : '') + '</span></div>' + (o.length ? grp(o, 'cal', false, false) : '') +
    (dn.length ? '<p class="tdSub"><span>Done (' + dn.length + ')</span></p>' + grp(dn, 'caldone', false, false) : '') + (!day.length ? '<p class="wn">Nothing due on this day.</p>' : '') + '</div>';
}
$('#todoCard').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.ls){ if (b.dataset.ls === '+') openListDlg(null); else { tdSel = b.dataset.ls; drawTodo(); } return; }
  if (b.dataset.tf){ tdTags = tdTags.includes(b.dataset.tf) ? tdTags.filter(g => g !== b.dataset.tf) : tdTags.concat(b.dataset.tf); drawTodo(); return; }
  if (b.dataset.tc){ tdTags = []; drawTodo(); return; }
  if (b.dataset.tn){ openTagDlg(null, null); return; }
  if (b.dataset.te){ openTagDlg(tdTags[0], null); return; }
  if (b.dataset.cd){ tdCalDay = b.dataset.cd; tdCalMonth = tdCalDay.slice(0, 7) + '-01'; drawTodo(); return; }
  if (b.dataset.cw){ if (calSwiped){ calSwiped = false; return; } tdSetPref('calWeek', !tdPrefs().calWeek); drawTodo(); return; }
  if (b.dataset.cm !== undefined){
    const n = +b.dataset.cm, td = todayStr(), week = !!tdPrefs().calWeek;
    if (n === 0){ tdCalMonth = td.slice(0, 7) + '-01'; tdCalDay = td; }
    else if (week){ tdCalDay = addDays(tdCalDay || td, n * 7); tdCalMonth = tdCalDay.slice(0, 7) + '-01'; }
    else { tdCalMonth = shiftMonth(tdCalMonth || td, n); tdCalDay = tdCalMonth.slice(0, 7) === td.slice(0, 7) ? td : tdCalMonth; }
    drawTodo(); return;
  }
  if (b.id === 'tdListEdit'){ openListDlg(tdSel); return; }
  if (b.id === 'tdDoneTog'){ tdSetPref('done', !tdPrefs().done); drawTodo(); return; }
  if (b.dataset.sec){ const h = new Set(tdPrefs().hide || []); if (h.has(b.dataset.sec)) h.delete(b.dataset.sec); else h.add(b.dataset.sec); tdSetPref('hide', [...h]); drawTodo(); return; }
  if (b.dataset.ex){ if (tdOpen.has(b.dataset.ex)) tdOpen.delete(b.dataset.ex); else tdOpen.add(b.dataset.ex); drawTodo(); return; }
  const l = store.get('todos', []);
  if (b.dataset.dp){
    const it = l.find(x => x.id === b.dataset.dp); if (!it) return;
    openDatePick({ due:it.due, dt:it.dt, rep:it.rep }, v => { const l2 = store.get('todos', []), z = l2.find(x => x.id === it.id); if (!z) return; tdPut(z, v); store.set('todos', l2); drawTodo(); });
    return;
  }
  if (b.dataset.tg){
    const it = l.find(x => x.id === b.dataset.tg);
    if (it && !it.done && it.rep && it.due){        // a repeating to-do: ticking it moves it to its next date
      const _s = grab(); tdAdvance(it); store.set('todos', l); store.set('todoLog', logDone(store.get('todoLog', []), it, todayStr())); drawTodo(); try{ if (navigator.vibrate) navigator.vibrate(15); }catch{}
      showUndo('Done. Next: ' + (tdDue(it) || { text:it.due }).text, _s);
    } else if (it){ it.done = !it.done; store.set('todos', l); store.set('todoLog', it.done ? logDone(store.get('todoLog', []), it, todayStr()) : unlogDone(store.get('todoLog', []), it.id)); drawTodo(); try{ if (it.done && navigator.vibrate) navigator.vibrate(15); }catch{} }
  }
  else if (b.dataset.st){ const it = l.find(x => x.id === b.dataset.st); if (it){ if (it.star) delete it.star; else it.star = true; store.set('todos', l); drawTodo(); } }
  else if (b.dataset.sg){ const it = l.find(x => x.id === b.dataset.sg), s = it && Array.isArray(it.steps) ? it.steps[+b.dataset.si] : null; if (s){ s.d = !s.d; store.set('todos', l); drawTodo(); } }
  else if (b.dataset.ed) openTodoEd(b.dataset.ed);
  else if (b.id === 'tdClear'){
    const ls = tdLists(), _s = grab(); store.set('todos', l.filter(x => !(x.done && tdIn(x, tdSel, ls)))); drawTodo(); showUndo('Cleared the done to-dos', _s);
  }
});
$('#todoCard').addEventListener('change', e => { if (e.target.id === 'td_sort'){ tdSetPref('sort', e.target.value); drawTodo(); } });
// the top-right buttons: tag filter, and the list / calendar switch
$('#tdHdr').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.vm){ tdSetPref('mode', b.dataset.vm); if (b.dataset.vm === 'cal' && tdIsSmart(tdSel)) tdSel = 'all'; drawTodo(); return; }
  if (b.id === 'tdHash'){ if (tdTagRow || tdTags.length){ tdTagRow = false; tdTags = []; } else tdTagRow = true; drawTodo(); }
});
// the calendar's handle: tap it, or swipe it up (week only) or down (whole month)
let calSwiped = false;
(function(){
  let y0 = null;
  const card = $('#todoCard');
  card.addEventListener('pointerdown', e => { y0 = e.target.closest('.calHandle') ? e.clientY : null; });
  card.addEventListener('pointerup', e => {
    if (y0 === null) return; const dy = e.clientY - y0; y0 = null;
    if (Math.abs(dy) < 18) return;
    calSwiped = true; setTimeout(() => { calSwiped = false; }, 400);
    tdSetPref('calWeek', dy < 0); drawTodo();
  });
  card.addEventListener('pointercancel', () => { y0 = null; });
})();
// drag a to-do by its handle; it moves within its own group (starred, overdue, other, or done)
function tdReorder(ids){
  const l = store.get('todos', []), set = new Set(ids), slots = [];
  l.forEach((x, i) => { if (set.has(x.id)) slots.push(i); });
  const by = {}; l.forEach(x => { by[x.id] = x; });
  ids.forEach((id, k) => { if (by[id] !== undefined && slots[k] !== undefined) l[slots[k]] = by[id]; });
  store.set('todos', l); drawTodo();
}
(function(){
  let row = null, box = null; const card = $('#todoCard');
  card.addEventListener('pointerdown', e => { const h = e.target.closest('.tdH'); if (!h) return; row = h.closest('.tdItem'); box = row.parentElement; row.classList.add('drag'); h.setPointerCapture(e.pointerId); e.preventDefault(); });
  card.addEventListener('pointermove', e => {
    if (!row) return;
    const others = [...box.children].filter(r => r !== row); let before = null;
    for (const r of others){ const bb = r.getBoundingClientRect(); if (e.clientY < bb.top + bb.height / 2){ before = r; break; } }
    if (before !== row.nextElementSibling) box.insertBefore(row, before);
  });
  const end = () => {
    if (!row) return;
    const ids = [...box.children].map(r => r.dataset.id), g = box.dataset.grp, s = tdPrefs().sort;
    row.classList.remove('drag'); row = null; box = null;
    if (s !== 'mine' && s !== 'date'){ tdSetPref('sort', 'mine'); toast('Sorting is now My order'); }
    tdReorder(ids);
    if (s === 'date'){      // By date keeps its sections; only tasks with the same date and time can swap places
      const now = [...document.querySelectorAll('#todoCard .tdList[data-grp="' + g + '"] .tdItem')].map(r => r.dataset.id);
      if (now.length && now.join() !== ids.join()) toast('This list follows due date and time. Change the date to move it.');
    }
  };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
})();
// ---- the due-date picker: one sheet for the editor, a card's date, and the composer ----
let dpS = { due:'', dt:'', rep:'' }, dpCb = null, dpMon = '';
$('#dp_wd').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => '<span>' + n + '</span>').join('');
function openDatePick(v, cb){
  dpS = { due:v.due || '', dt:v.dt || '', rep:v.rep || '' }; dpCb = cb;
  dpMon = (dpS.due || todayStr()).slice(0, 7) + '-01'; drawDp(); $('#dpDlg').showModal();
}
function drawDp(){
  const td = todayStr(), g = monthGrid(dpMon);
  $('#dp_mon').textContent = parseDay(dpMon).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  $('#dp_grid').innerHTML = '<span></span>'.repeat(g.lead) + g.days.map(iso => '<button type="button" class="dpD' + (iso === td ? ' today' : '') + (iso === dpS.due ? ' sel' : '') + (iso < td ? ' past' : '') + '" data-d="' + iso + '" aria-pressed="' + (iso === dpS.due) + '" aria-label="' + esc(parseDay(iso).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })) + '">' + +iso.slice(8) + '</button>').join('');
  [...$('#dp_chips').children].forEach(b => { const q = b.dataset.q; b.classList.toggle('on', q === 'none' ? !dpS.due : !!dpS.due && dpS.due === quickDate(q, td)); });
  $('#dp_tm').value = dpS.dt; $('#dp_tV').textContent = dpS.dt ? fmt(tdMin(dpS.dt)).join(' ') : 'None'; $('#dp_tX').hidden = !dpS.dt;
  $('#dp_rep').value = dpS.rep; $('#dp_rV').textContent = TD_REP[dpS.rep] || 'Never';
  $('#dp_clr').hidden = !dpS.due && !dpS.dt && !dpS.rep;
}
$('#dp_grid').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; dpS.due = b.dataset.d; drawDp(); });
$('#dp_chips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; const q = b.dataset.q;
  if (q === 'none') dpS = { due:'', dt:'', rep:'' }; else { dpS.due = quickDate(q, todayStr()); dpMon = dpS.due.slice(0, 7) + '-01'; }
  drawDp();
});
$('#dp_prev').onclick = () => { dpMon = shiftMonth(dpMon, -1); drawDp(); };
$('#dp_next').onclick = () => { dpMon = shiftMonth(dpMon, 1); drawDp(); };
$('#dp_tm').addEventListener('change', e => { dpS.dt = e.target.value; if (dpS.dt && !dpS.due) dpS.due = todayStr(); drawDp(); });
$('#dp_tX').onclick = e => { e.preventDefault(); e.stopPropagation(); dpS.dt = ''; drawDp(); };
$('#dp_rep').addEventListener('change', e => { dpS.rep = e.target.value; if (dpS.rep && !dpS.due) dpS.due = todayStr(); drawDp(); });
$('#dp_clr').onclick = () => { dpS = { due:'', dt:'', rep:'' }; drawDp(); };
$('#dp_ok').onclick = () => { const cb = dpCb, v = { due:dpS.due, dt:dpS.due ? dpS.dt : '', rep:dpS.due ? dpS.rep : '' }; dpCb = null; $('#dpDlg').close(); if (cb) cb(v); };
$('#dp_x').onclick = () => $('#dpDlg').close();
$('#dpDlg').addEventListener('click', e => { if (e.target === $('#dpDlg')) $('#dpDlg').close(); });
$('#dpDlg').addEventListener('close', () => { dpCb = null; });

// ---- the composer at the bottom of the To-do tab: type, set a date or star if it matters, send ----
$('#tdCapS').innerHTML = TD_STAR; $('#tdCapGo').innerHTML = IN_UP;
function tdCapSync(){ $('#tdCapGo').disabled = !$('#tdCapT').value.trim(); }
function tdCapAdd(){
  const v = $('#tdCapT').value.trim(); if (!v) return;
  const st = tdCapState(), ls = tdLists(), l = store.get('todos', []), _s = grab();
  const it = { id:'t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t:v, done:false, l:tdListSel(ls) };
  tdPut(it, st); if (st.star) it.star = true; if (tdTags.length) it.tags = tdTags.slice();
  l.push(it); store.set('todos', l);
  const seen = tdIn(it, tdSel, ls) && !(tdPrefs().mode === 'cal' && it.due !== tdCalDay);
  $('#tdCapT').value = ''; tdCapOv = {}; tdCapSync(); tdFresh = it.id; drawTodo();
  const r = document.querySelector('.tdItem[data-id="' + it.id + '"]'); if (r) r.scrollIntoView({ block:'nearest', behavior:'smooth' });
  setTimeout(() => { tdFresh = null; }, 1600);
  if (!seen) showUndo('Added to ' + tdName(it.l, ls) + (it.due ? ', ' + tdDay(it.due) : ''), _s);
}
$('#tdCapGo').onclick = () => { tdCapAdd(); $('#tdCapT').focus(); };
$('#tdCapT').addEventListener('input', tdCapSync);
$('#tdCapT').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); tdCapAdd(); } });
$('#tdCapS').onclick = () => { tdCapOv.star = !tdCapState().star; drawTodoCap(tdLists()); };
$('#tdCapD').onclick = () => { const st = tdCapState(); openDatePick(st, v => { tdCapOv.due = v.due; tdCapOv.dt = v.dt; tdCapOv.rep = v.rep; drawTodoCap(tdLists()); }); };
tdCapSync();
setInterval(tdBadge, 20000);

// ---- the to-do editor: a sheet with the name, date, list, tags, subtasks and note ----
let tdeId = null;
function tdeSync(){        // the grey summary on the right of each row
  const d = $('#tde_d').value, tm = $('#tde_tm').value, rep = $('#tde_rep').value, ls = tdLists(), tg = store.get('todoTags', []);
  const dv = $('#tde_dV'); dv.textContent = d ? tdDayLong(d) : 'None'; dv.classList.toggle('late', !!d && d < todayStr());
  $('#tde_tmV').textContent = tm ? fmt(tdMin(tm)).join(' ') : 'None'; $('#tde_tmX').hidden = !tm;
  $('#tde_repV').textContent = TD_REP[rep] ? TD_REP[rep].replace('Daily', 'Every day').replace('Weekly', 'Every week').replace('Monthly', 'Every month').replace('Yearly', 'Every year') : 'Never';
  const lid = $('#tde_list').value || 'main', L = ls.find(x => x.id === lid) || ls[0];
  $('#tde_lV').innerHTML = '<i class="mDot" style="--c:' + tdLc(L.id, ls) + '"></i>' + esc(L.name);
  const on = tg.filter(t => tdeTags.includes(t.id));
  $('#tde_tgV').innerHTML = on.length ? on.slice(0, 2).map(t => '<span class="tdTg tdTgP" style="--tc:' + (t.c || 'var(--accent)') + '">#' + esc(t.name) + '</span>').join('') + (on.length > 2 ? '<span class="tdTgN">+' + (on.length - 2) + '</span>' : '') : 'None';
  const c = $('#tde_color').value || tdLc(L.id, ls), ic = $('#tde_icon').value;      // no colour of its own: it takes its list's
  $('#tde_clV').innerHTML = (ic ? '<i class="tdeIc" style="color:' + c + '">' + iconMarkup(ic) + '</i>' : '') + '<i class="mDot" style="--c:' + c + '"></i>';
}
function tdePanel(btn, panel, on){ $(panel).hidden = !on; $(btn).setAttribute('aria-expanded', on ? 'true' : 'false'); }
function openTodoEd(id, preset){
  tdeId = id || null;
  const it = id ? store.get('todos', []).find(x => x.id === id) : null, ls = tdLists();
  $('#tde_title').textContent = it ? 'Edit to-do' : 'New to-do'; $('#tde_ok').textContent = it ? 'Save' : 'Add';
  $('#tde_t').value = it ? it.t : '';
  $('#tde_lw').style.display = ls.length > 1 ? '' : 'none';
  $('#tde_list').innerHTML = ls.map(x => '<option value="' + x.id + '">' + esc(x.name) + '</option>').join('');
  $('#tde_list').value = it ? tdListOf(it, ls) : tdListSel(ls);
  const def = tdCapDef(), pre = it ? {} : Object.assign({}, def.due ? { due:def.due } : {}, def.star ? { star:true } : {}, preset || {});   // a new to-do starts as the view you are in
  tdeTags = it ? (Array.isArray(it.tags) ? it.tags.slice() : []) : tdTags.slice(); drawTdeTags();
  $('#tde_d').value = it ? it.due || '' : pre.due || ''; $('#tde_tm').value = it && it.dt || ''; $('#tde_rep').value = it && it.rep || '';
  const on = !!(it ? it.star : pre.star); $('#tde_star').classList.toggle('on', on); $('#tde_star').setAttribute('aria-pressed', on);
  $('#tde_note').value = it && it.note || '';
  tdeSteps.set(it && it.steps);
  $('#tde_icon').value = it && it.ic || ''; $('#tde_color').value = it && it.c || ''; tdeIconBtn(); CT = 'tde'; drawColorRow('tde');
  tdePanel('#tde_tgRow', '#tde_tgP', false); tdePanel('#tde_clRow', '#tde_clP', false);
  $('#tde_err').hidden = true; $('#tde_move').style.display = it ? '' : 'none';
  tdeSync();
  $('#tdeDlg').showModal(); $('#tdeDlg .tdeBody').scrollTop = 0;
  if (!it){ $('#tde_t').focus(); setTimeout(() => $('#tde_t').focus(), 80); } else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function tdeSave(){
  const err = msg => { $('#tde_err').textContent = msg; $('#tde_err').hidden = false; };
  const t = $('#tde_t').value.trim(); if (!t){ err('Give the to-do a name.'); return; }
  let due = $('#tde_d').value; const dt = $('#tde_tm').value, rep = $('#tde_rep').value;
  if (rep && !due) due = todayStr();             // a repeating to-do needs a date to start from
  if (dt && !due){ err('Pick a date for that time, or clear the time.'); return; }
  const l = store.get('todos', []); let it = tdeId ? l.find(x => x.id === tdeId) : null;
  if (!it){ it = { id:'t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), done:false }; l.push(it); }
  const put = (k, v) => { if (v) it[k] = v; else delete it[k]; };
  it.t = t; it.l = $('#tde_lw').style.display === 'none' ? (it.l || tdListSel()) : $('#tde_list').value;
  put('due', due); put('dt', due ? dt : ''); put('rep', rep); put('star', $('#tde_star').classList.contains('on') ? true : undefined);
  put('note', $('#tde_note').value.trim());
  put('ic', $('#tde_icon').value); put('c', $('#tde_color').value);
  if (tdeTags.length) it.tags = tdeTags.slice(); else delete it.tags;
  const st = tdeSteps.get(); if (st.length) it.steps = st; else delete it.steps;
  tdFresh = tdeId ? null : it.id; setTimeout(() => { tdFresh = null; }, 1600);
  store.set('todos', l); $('#tdeDlg').close(); drawTodo();
}
function tdeIconBtn(){ const v = $('#tde_icon').value; $('#tde_iconBtn').innerHTML = v ? iconMarkup(v) : '+'; tdeSync(); }
$('#tde_iconBtn').addEventListener('click', () => {
  ipTarget = v => { $('#tde_icon').value = v || ''; tdeIconBtn(); };
  const v = $('#tde_icon').value; $('#e_icon_custom').value = v && !ICONS[v] ? v : ''; $('#ip_q').value = ''; drawIconPicker('');
  $('#iconPick').showModal(); $('#ip_scroll').scrollTop = 0; ipSpy();
});
new MutationObserver(tdeSync).observe($('#tde_colors'), { childList:true });      // picking a colour redraws the swatches
$('#tde_ok').onclick = tdeSave;
$('#tde_x').onclick = () => $('#tdeDlg').close();
$('#tde_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); tdeSave(); } });
$('#tde_star').onclick = () => { const on = !$('#tde_star').classList.contains('on'); $('#tde_star').classList.toggle('on', on); $('#tde_star').setAttribute('aria-pressed', on); };
$('#tde_dRow').onclick = () => openDatePick({ due:$('#tde_d').value, dt:$('#tde_tm').value, rep:$('#tde_rep').value }, v => {
  $('#tde_d').value = v.due; $('#tde_tm').value = v.dt; $('#tde_rep').value = v.rep; $('#tde_err').hidden = true; tdeSync();
});
$('#tde_tm').addEventListener('change', () => { if ($('#tde_tm').value && !$('#tde_d').value) $('#tde_d').value = todayStr(); $('#tde_err').hidden = true; tdeSync(); });
$('#tde_tmX').onclick = e => { e.preventDefault(); e.stopPropagation(); $('#tde_tm').value = ''; tdeSync(); };
$('#tde_rep').addEventListener('change', () => { if ($('#tde_rep').value && !$('#tde_d').value) $('#tde_d').value = todayStr(); tdeSync(); });
$('#tde_list').addEventListener('change', tdeSync);
$('#tde_tgRow').onclick = () => tdePanel('#tde_tgRow', '#tde_tgP', $('#tde_tgP').hidden);
$('#tde_clRow').onclick = () => tdePanel('#tde_clRow', '#tde_clP', $('#tde_clP').hidden);
// Send to Timeline: opens the task editor with this to-do filled in. The to-do leaves the list only when that task is saved.
$('#tde_tl').onclick = () => {
  if (!tdeId) return;
  const t = $('#tde_t').value.trim(); if (!t){ $('#tde_err').textContent = 'Give the to-do a name.'; $('#tde_err').hidden = false; return; }
  const due = $('#tde_d').value, tm = tdMin($('#tde_tm').value), note = $('#tde_note').value.trim(), steps = tdeSteps.get().map(s => s.t), id = tdeId;
  const ic = $('#tde_icon').value, col = $('#tde_color').value;
  $('#tdeDlg').close(); setTab('home');
  if (due && due >= todayStr() && due !== viewDate) goDate(due);        // schedule it on its due day
  openEd('oo', null, defaultWin(), due && tm !== null ? tm : undefined);
  $('#e_t').value = t; $('#e_details').value = note; edSteps.set(steps); cur.fromTodo = id;
  if (ic){ $('#e_icon').value = ic; updateIconBtn(); }
  if (col){ $('#e_color').value = col; drawColorRow('e'); setEdAccent(); }       // the icon and colour come along
};
$('#tde_inbox').onclick = async () => {
  if (!tdeId) return;
  const t = $('#tde_t').value.trim(); if (!t){ $('#tde_err').textContent = 'Give the to-do a name.'; $('#tde_err').hidden = false; return; }
  const lose = $('#tde_d').value || tdeSteps.get().length;
  if (lose && !await ask('Inbox tasks have no date or subtasks, so those would be dropped. Move it anyway?', { ok:'Move to Inbox' })) return;
  const _s = grab(), id = tdeId;
  store.set('inbox', insertNew(store.get('inbox', []), makeTask(t, { note:$('#tde_note').value })));
  store.set('todos', store.get('todos', []).filter(x => x.id !== id));
  $('#tdeDlg').close(); drawTodo(); drawInbox(); showUndo('Moved to Inbox', _s);
};
$('#tde_del').onclick = () => {
  if (!tdeId) return; const _s = grab(); store.set('todos', store.get('todos', []).filter(x => x.id !== tdeId)); $('#tdeDlg').close(); drawTodo(); showUndo('To-do removed', _s);
};
// ---- list names, icons and colours ----
let tdlEdit = null;
function tdlIconBtn(){ $('#tdl_iconBtn').innerHTML = iconMarkup($('#tdl_icon').value || 'checklist'); }
function openListDlg(id){
  tdlEdit = id; const ls = tdLists(), i = id ? ls.findIndex(x => x.id === id) : -1, it = i >= 0 ? ls[i] : null;
  $('#tdl_title').textContent = it ? 'Edit list' : 'New list'; $('#tdl_t').value = it ? it.name : '';
  $('#tdl_icon').value = it ? (it.ic || 'checklist') : 'checklist';
  $('#tdl_color').value = it ? tdListColor(it, i) : TD_NEW[(ls.length - 1) % TD_NEW.length];
  tdlIconBtn(); CT = 'tdl'; drawColorRow('tdl');
  $('#tdl_del').hidden = !it || id === 'main';
  $('#tdlDlg').showModal(); $('#tdl_t').focus(); setTimeout(() => $('#tdl_t').focus(), 80);
}
function tdlSave(){
  const v = $('#tdl_t').value.trim(); if (!v) return;
  const ls = tdLists(), it = tdlEdit ? ls.find(x => x.id === tdlEdit) : null, ic = $('#tdl_icon').value, c = $('#tdl_color').value;
  const put = (o, k, val) => { if (val) o[k] = val; else delete o[k]; };
  if (it){ it.name = v; put(it, 'ic', ic); put(it, 'c', c); }
  else { const n = { id:'l' + Date.now().toString(36), name:v }; put(n, 'ic', ic); put(n, 'c', c); ls.push(n); tdSel = n.id; }
  store.set('todoLists', ls); $('#tdlDlg').close(); drawTodo();
}
$('#tdl_ok').onclick = tdlSave;
$('#tdl_x').onclick = () => $('#tdlDlg').close();
$('#tdl_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); tdlSave(); } });
$('#tdlDlg').addEventListener('close', () => { pickTok++; });
$('#tdl_iconBtn').addEventListener('click', () => {
  ipTarget = v => { $('#tdl_icon').value = v || 'checklist'; tdlIconBtn(); };
  $('#e_icon_custom').value = ''; $('#ip_q').value = ''; drawIconPicker('');
  $('#iconPick').showModal(); $('#ip_scroll').scrollTop = 0; ipSpy();
});
$('#tdl_del').onclick = () => {
  const id = tdlEdit; if (!id || id === 'main') return;
  const _s = grab(), ls = tdLists().filter(x => x.id !== id), t = store.get('todos', []);
  t.forEach(x => { if (x.l === id) x.l = 'main'; });       // the to-dos are kept: they move to the first list
  store.set('todos', t); store.set('todoLists', ls); tdSel = 'all'; $('#tdlDlg').close(); drawTodo(); showUndo('List deleted. Its to-dos moved to ' + ls[0].name, _s);
};

// ---- tags: shared by every list, each with its own colour ----
let tgEdit = null, tgAfter = null;     // tgAfter: called with the saved tag (the to-do editor uses it to pick the new tag)
function openTagDlg(id, after){
  tgEdit = id; tgAfter = after || null;
  const tags = store.get('todoTags', []), t = id ? tags.find(x => x.id === id) : null;
  $('#tg_title').textContent = t ? 'Edit tag' : 'New tag'; $('#tg_t').value = t ? t.name : '';
  $('#tg_color').value = t ? t.c || '' : TD_NEW[tags.length % TD_NEW.length];
  CT = 'tg'; drawColorRow('tg'); $('#tg_del').hidden = !t;
  $('#tgDlg').showModal(); $('#tg_t').focus(); setTimeout(() => $('#tg_t').focus(), 80);
}
function tgSave(){
  const name = $('#tg_t').value.trim().replace(/^#+/, '').replace(/\s+/g, '-'); if (!name) return;
  const tags = store.get('todoTags', []), c = $('#tg_color').value;
  const dupe = tags.find(t => t.name.toLowerCase() === name.toLowerCase() && t.id !== tgEdit);
  let t = dupe;                                                   // the same name again just reuses that tag
  if (!t && tgEdit){ t = tags.find(x => x.id === tgEdit); if (t){ t.name = name; t.c = c; } }
  if (!t){ t = { id:'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), name, c }; tags.push(t); }
  store.set('todoTags', tags); $('#tgDlg').close(); drawTodo(); if (tgAfter) tgAfter(t);
}
$('#tg_ok').onclick = tgSave;
$('#tg_x').onclick = () => $('#tgDlg').close();
$('#tg_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); tgSave(); } });
$('#tg_del').onclick = () => {
  const id = tgEdit; if (!id) return;
  const _s = grab(), t = store.get('todos', []);
  t.forEach(x => { if (x.tags){ x.tags = x.tags.filter(g => g !== id); if (!x.tags.length) delete x.tags; } });
  store.set('todos', t); store.set('todoTags', store.get('todoTags', []).filter(x => x.id !== id)); tdTags = tdTags.filter(g => g !== id);
  $('#tgDlg').close(); drawTodo(); showUndo('Tag deleted', _s);
};
// tags inside the to-do editor
let tdeTags = [];
function drawTdeTags(){
  const tags = store.get('todoTags', []);
  $('#tde_tags').innerHTML = tags.map(t => '<button type="button" class="tgChip' + (tdeTags.includes(t.id) ? ' on' : '') + '" data-tt="' + t.id + '" aria-pressed="' + tdeTags.includes(t.id) + '" style="--tc:' + (t.c || 'var(--accent)') + '">#' + esc(t.name) + '</button>').join('') + '<button type="button" class="tgChip tgNew" data-tn="1">+ New tag</button>'; tdeSync();
}
$('#tde_tags').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tn){ openTagDlg(null, t => { if (!tdeTags.includes(t.id)) tdeTags.push(t.id); drawTdeTags(); }); return; }
  const id = b.dataset.tt; tdeTags = tdeTags.includes(id) ? tdeTags.filter(g => g !== id) : tdeTags.concat(id); drawTdeTags();
});


// ---- calendar (.ics) import ----
function icsDate(v){
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(v.trim()); if (!m) return null;
  if (m[4] === undefined) return { allDay:true };
  return { d: m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) };
}
function parseICS(txt){
  const L = txt.replace(/\r/g, '').replace(/\n[ \t]/g, '').split('\n'), ev = []; let c = null;
  L.forEach(l => {
    if (l === 'BEGIN:VEVENT') c = {};
    else if (l === 'END:VEVENT'){ if (c) ev.push(c); c = null; }
    else if (c){
      const i = l.indexOf(':'); if (i < 0) return;
      const key = l.slice(0, i).split(';')[0].toUpperCase(), val = l.slice(i + 1);
      if (key === 'DTSTART') c.s = icsDate(val); else if (key === 'DTEND') c.e = icsDate(val);
      else if (key === 'SUMMARY') c.t = val.replace(/\\n/gi, ' ').replace(/\\([,;])/g, '$1').replace(/\\\\/g, '\\');
      else if (key === 'RRULE') c.r = true;
    }
  });
  return ev;
}
function importICS(txt){
  const today = parseDay(todayStr()), lo = new Date(today), hi = new Date(today);
  lo.setDate(lo.getDate() - 30); hi.setDate(hi.getDate() + 90);
  const r = { added:0, allDay:0, rec:0, out:0 }, WB = wins();
  parseICS(txt).forEach(e => {
    if (!e.s || !e.t) return;
    if (e.s.allDay){ r.allDay++; return; }
    if (e.r) r.rec++;
    if (e.s.d < lo || e.s.d > hi){ r.out++; return; }
    const ds = isoLocal(e.s.d), start = e.s.d.getHours() * 60 + e.s.d.getMinutes();
    let dur = e.e && e.e.d ? Math.round((e.e.d - e.s.d) / 60000) : 30; if (!(dur > 0)) dur = 30; dur = Math.min(dur, 600);
    const p = plans[ds] || planFor(ds) || { w:defWake(), d:[], t:{}, a:false, n:'' }, n = start - p.w;
    let w = 'climb1'; for (const k of Object.keys(WB)) if (n >= WB[k].from && n < WB[k].to) w = k;
    const id = 'ics' + [...(ds + start + e.t)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7).toString(36);
    p.o = (p.o || []).filter(x => x.id !== id).concat({ id, t:e.t.slice(0, 80), d:dur, m:dur, p:'core', fixed:start, w, icon:'calendar' });
    plans[ds] = p; r.added++;
  });
  store.set('plans', plans); loadDay(viewDate); render();
  return r;
}

// ---- appearance + settings cards ----
function applyLook(){
  const T = store.get('theme', 'dark'), P = PALS.find(p => p.id === T);
  const base = T === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : (P ? P.base : 'dark'), R = document.documentElement;
  R.dataset.theme = base; if (P && P.id !== 'dark' && P.id !== 'light') R.dataset.pal = P.id; else delete R.dataset.pal;
  R.dataset.text = store.get('text', 'normal');
  const A = ACCENTS.find(a => a.id === store.get('accent', 'blue')) || ACCENTS[0], hex = base === 'light' ? A.light : A.dark;
  R.style.setProperty('--accent', hex); R.style.setProperty('--onacc', onAccent(hex));
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = getComputedStyle(R).getPropertyValue('--bg').trim() || (base === 'light' ? '#f3f5fb' : '#1c1c1e');
  drawAccRow();
}
function drawAccRow(){
  const el = document.getElementById('accRow'); if (!el) return;
  const cur = store.get('accent', 'blue'), light = document.documentElement.dataset.theme === 'light';
  el.innerHTML = ACCENTS.map(a => '<button type="button" class="accSw" role="radio" data-ac="' + a.id + '" aria-checked="' + (a.id === cur) + '" aria-label="' + a.name + '" style="--c:' + (light ? a.light : a.dark) + '"></button>').join('');
}
const selOpts = (arr, cur) => arr.map(o => '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>').join('');
$('#tab-settings').insertAdjacentHTML('beforeend',
  '<div class="sleep"><h2>Energy rhythm</h2><p class="wn">Shifts when your energy windows start: 30 min earlier, as planned, or 45 min later. My rhythm learns your own timing from your energy ratings.</p><div class="capRow"><label for="chrSel">Rhythm</label><select id="chrSel">' + selOpts([['early', 'Early bird'], ['normal', 'In between'], ['late', 'Night owl'], ['mine', 'My rhythm']], store.get('chrono', 'normal')) + '</select></div><div id="rhyBox"></div></div>' +
  '<div class="sleep"><h2>Appearance</h2><div class="capRow"><label for="thSel">Theme</label><select id="thSel">' + selOpts(PALS.map(p => [p.id, p.name]).concat([['auto', 'Match device']]), store.get('theme', 'dark')) + '</select></div><div class="accBlock"><label id="accLab">Accent colour</label><div id="accRow" role="radiogroup" aria-labelledby="accLab"></div></div><div class="capRow"><label for="clkSel">Clock</label><select id="clkSel">' + selOpts([['12', '12-hour'], ['24', '24-hour']], store.get('clock', '12')) + '</select></div><div class="capRow"><label for="txSel">Text size</label><select id="txSel">' + selOpts([['normal', 'Normal'], ['large', 'Large']], store.get('text', 'normal')) + '</select></div></div>' +
  '<div class="sleep"><h2>Calendar import</h2><p class="wn">Import a .ics file from Google, Apple or Outlook calendar. Timed events become fixed-time one-off tasks (30 days back, 90 ahead, in your device time zone). All-day events are skipped, and recurring events import only their first occurrence.</p><button class="add" id="icsBtn">Choose .ics file</button><input type="file" id="icsF" accept=".ics,text/calendar" hidden></div>');
$('#tab-settings').addEventListener('change', e => {
  if (e.target.id === 'chrSel'){
    const v = e.target.value;
    if (v === 'mine'){   // choosing it yourself starts from what your ratings say, if they say anything yet
      const a = rhyRead(), r = { ...rhyState() };
      if (a.status === 'ready' && r.on !== true){ r.shift = rhyAsk(a, { current:0, never:false, snooze:null }).shift; r.on = true; store.set('rhythm', r); }
    }
    store.set('chrono', v); render();
  }
  else if (e.target.id === 'thSel'){ store.set('theme', e.target.value); applyLook(); }
  else if (e.target.id === 'txSel'){ store.set('text', e.target.value); applyLook(); }
  else if (e.target.id === 'clkSel'){ store.set('clock', e.target.value); CLOCK24 = e.target.value === '24'; drawClock(); render(); }
});
$('#tab-settings').addEventListener('click', e => {
  const rb = e.target.closest('[data-rhy]'); if (rb){ rhyAct(rb.dataset.rhy); return; }
  const b = e.target.closest('.accSw'); if (b){ store.set('accent', b.dataset.ac); applyLook(); }
});
$('#icsBtn').addEventListener('click', () => $('#icsF').click());
$('#icsF').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const r = importICS(String(rd.result));
    tell('Imported ' + r.added + ' event' + (r.added === 1 ? '' : 's') + '.' + (r.allDay ? ' Skipped ' + r.allDay + ' all-day.' : '') + (r.out ? ' Skipped ' + r.out + ' outside the date range.' : '') + (r.rec ? ' ' + r.rec + ' recurring (first occurrence only).' : ''));
  };
  rd.readAsText(f); e.target.value = '';
});
applyLook();

// ---- welcome cards (first run, after a reset, and from About) ----
let welFlow = false, welIdx = 0;
function welGo(i){
  const t = $('#wl_track'), n = t.children.length; welIdx = Math.max(0, Math.min(n - 1, i));
  $('#wl_dots').innerHTML = Array.from({ length:n }, (_, k) => '<i' + (k === welIdx ? ' class="on"' : '') + ' data-k="' + k + '"></i>').join('');
  $('#wl_back').hidden = welIdx === 0;
  $('#wl_next').textContent = welIdx === n - 1 ? (welFlow ? 'Get started' : 'Done') : 'Next';
  $('#wl_skip').hidden = welIdx === n - 1;
  [...t.children].forEach((c, k) => c.classList.toggle('on', k === welIdx));
  $('#welDlg').style.setProperty('--g', t.children[welIdx].style.getPropertyValue('--g') || '#3b82f6');
}
function openWelcome(flow){
  { const R = { early:'Early bird', normal:'In between', late:'Night owl' }, b = store.get('blocks', null) || {}, wk = store.get('wake', DEF_WAKE);
    if ($('#wl_sWake')) $('#wl_sWake').textContent = clk(typeof wk === 'number' ? wk : DEF_WAKE); if ($('#wl_sRhy')) $('#wl_sRhy').textContent = R[store.get('chrono', 'normal')] || 'In between';
    if ($('#wl_sPre')) $('#wl_sPre').textContent = b.pre && b.pre.length ? b.pre.length + ' tasks' : 'Start empty'; }
  welFlow = !!flow; $('#welDlg').showModal(); $('#wl_track').scrollLeft = 0; welMode('Home', false); welGo(0);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
$('#wl_track').addEventListener('scroll', () => { const t = $('#wl_track'), i = Math.round(t.scrollLeft / Math.max(1, t.clientWidth)); if (i !== welIdx) welGo(i); });
$('#wl_next').onclick = () => { const t = $('#wl_track'); if (welIdx >= t.children.length - 1) $('#welDlg').close(); else t.scrollTo({ left:(welIdx + 1) * t.clientWidth, behavior:'smooth' }); };
$('#wl_skip').onclick = () => $('#welDlg').close();
$('#wl_back').onclick = () => { const t = $('#wl_track'); t.scrollTo({ left:Math.max(0, welIdx - 1) * t.clientWidth, behavior:'smooth' }); };
$('#wl_dots').addEventListener('click', e => { const k = e.target.dataset && e.target.dataset.k; if (k != null){ const t = $('#wl_track'); t.scrollTo({ left:k * t.clientWidth, behavior:'smooth' }); } });
$('#welDlg').addEventListener('keydown', e => { if (e.key === 'ArrowRight') $('#wl_next').click(); else if (e.key === 'ArrowLeft' && welIdx > 0) $('#wl_back').click(); });
// the Home / School / Away demo on the tour: tap a mode and the sample cards change
const WEL_MODES = { Home:['Home · 4 tasks', 'Home · 3 tasks', 'Home · 2 tasks'], School:['School · 3 tasks', 'School · 5 tasks', 'School · 2 tasks'], Away:['Away · 2 tasks', 'Away · 1 task', 'Away · 2 tasks'] };
const WEL_CARDS = ['wl_m1', 'wl_m2', 'wl_m3'];
function welMode(name, anim){
  document.querySelectorAll('#welDlg .mkSeg span').forEach(x => x.classList.toggle('on', x.textContent === name));
  WEL_MODES[name].forEach((t, i) => { const e = document.getElementById(WEL_CARDS[i]); e.textContent = t; e.classList.remove('wlFlip'); if (anim){ void e.offsetWidth; e.classList.add('wlFlip'); } });
}
document.querySelectorAll('#welDlg .mkSeg span').forEach(s => s.addEventListener('click', () => welMode(s.textContent, true)));
$('#welDlg').addEventListener('close', () => { if (welFlow){ welFlow = false; store.set('welcomed', true); } });
document.addEventListener('click', e => { if (e.target.id === 'replayWel') openWelcome(false); });

// ---- go to a date: a month calendar in the same style as the To-do date picker ----
let jpMon = '';
$('#jp_wd').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => '<span>' + n + '</span>').join('');
function openJump(){
  jpMon = viewDate.slice(0, 7) + '-01'; drawJump(); $('#jumpDlg').showModal();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function drawJump(){
  const td = todayStr(), g = monthGrid(jpMon), lbl = iso => esc(parseDay(iso).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' }));
  $('#jp_mon').textContent = parseDay(jpMon).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  $('#jp_grid').innerHTML = '<span></span>'.repeat(g.lead) + g.days.map(iso => {
    const mt = dayMeta(iso), dots = dayColors(iso).map(x => '<i style="--c:' + x.c + '"></i>').join('');
    return '<button type="button" class="dpD jd' + (iso === td ? ' today' : '') + (iso === viewDate ? ' sel' : '') + (iso < td ? ' past' : '') + (mt.away ? ' away' : '') + '" data-d="' + iso + '" aria-label="' + lbl(iso) + (mt.away ? ', away day' : '') + (mt.note ? ', has a note' : '') + '">' + parseDay(iso).getDate() + (mt.note ? '<b class="jdn"></b>' : '') + '</button>';
  }).join('');
  [...$('#jp_chips').children].forEach(b => { const q = b.dataset.q; b.classList.toggle('on', viewDate === (q === 'yesterday' ? addDays(td, -1) : quickDate(q, td))); });
}
let jpLp = null, jpFired = false, jpX = null, jpY = 0, jpSw = false;
$('#jp_grid').addEventListener('pointerdown', e => {
  jpX = e.clientX; jpY = e.clientY; jpFired = false; jpSw = false; clearTimeout(jpLp); jpLp = null;
  const b = e.target.closest('.jd');
  if (b) jpLp = setTimeout(() => { jpLp = null; jpFired = true; if (navigator.vibrate) try{ navigator.vibrate(12); }catch{} openDayMenu(b.dataset.d); }, 450);
});
$('#jp_grid').addEventListener('pointermove', e => { if (jpLp && jpX !== null && (Math.abs(e.clientX - jpX) > 10 || Math.abs(e.clientY - jpY) > 10)){ clearTimeout(jpLp); jpLp = null; } });
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => $('#jp_grid').addEventListener(t, e => {
  clearTimeout(jpLp); jpLp = null;
  if (t === 'pointerup' && jpX !== null && !jpFired){
    const dx = e.clientX - jpX, dy = e.clientY - jpY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5){ jpSw = true; jpMon = shiftMonth(jpMon, dx < 0 ? 1 : -1); drawJump(); }
  }
  jpX = null;
}));
$('#jp_grid').addEventListener('contextmenu', e => e.preventDefault());
$('#jp_grid').addEventListener('click', e => { if (jpFired || jpSw){ jpFired = jpSw = false; return; } const b = e.target.closest('button'); if (!b) return; $('#jumpDlg').close(); goDate(b.dataset.d); });
$('#jp_chips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const td = todayStr(), q = b.dataset.q; $('#jumpDlg').close(); goDate(q === 'yesterday' ? addDays(td, -1) : quickDate(q, td)); });
$('#jp_prev').onclick = () => { jpMon = shiftMonth(jpMon, -1); drawJump(); };
$('#jp_next').onclick = () => { jpMon = shiftMonth(jpMon, 1); drawJump(); };
$('#jp_today').onclick = () => { $('#jumpDlg').close(); goDate(todayStr()); };
$('#jp_x').onclick = () => $('#jumpDlg').close();
$('#jumpDlg').addEventListener('click', e => { if (e.target === $('#jumpDlg')) $('#jumpDlg').close(); });

// ---- long-press a day in the week strip ----
let dmDay = '';
function openDayMenu(ds){
  dmDay = ds; const mt = dayMeta(ds), td = todayStr();
  $('#dm_title').textContent = parseDay(ds).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  const bits = []; if (ds === td) bits.push('Today'); if (mt.away) bits.push('Away day'); if (mt.note) bits.push('Has a note'); if (mt.rated) bits.push('Energy rated');
  $('#dm_sub').textContent = mt.past ? (mt.snap ? 'A past day. It is a read-only snapshot.' : 'A past day. It cannot be changed.') : (bits.join(' · ') || (ds > td ? 'Upcoming day' : 'Nothing set yet'));
  const row = (id, ic, name, sub) => '<button type="button" class="dtI" data-dm="' + id + '"><span class="dtIc">' + (ICONS[ic] || '') + '</span><span class="dtT"><b>' + name + '</b><small>' + sub + '</small></span></button>';
  let rows = '';
  if (ds !== viewDate) rows += row('open', 'calendar-check', 'Open this day', 'Jump to it');
  if (!mt.past){
    rows += row('away', 'suitcase', mt.away ? 'Remove Away day' : 'Set as Away day', mt.away ? 'Go back to your usual plan' : 'Tasks become suggestions');
    if (mt.note) rows += row('note', 'trash', 'Clear the note', 'Removes what you wrote');
  }
  $('#dmList').innerHTML = rows; $('#dmList').hidden = !rows;
  $('#dayDlg').showModal(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
$('#dmList').addEventListener('click', e => {
  const b = e.target.closest('[data-dm]'); if (!b) return;
  const ds = dmDay, a = b.dataset.dm, prev = viewDate; $('#dayDlg').close();
  if (a === 'open'){ if ($('#jumpDlg').open) $('#jumpDlg').close(); goDate(ds); return; }
  goDate(ds);
  if (a === 'away') $('#awayBtn').click(); else if (a === 'note'){ day.note = ''; saveDay(); }
  if (prev !== ds) goDate(prev); else render();      // stay where you were
  if ($('#jumpDlg').open) drawJump();
});
$('#dm_x').onclick = () => $('#dayDlg').close();

// ---- collapsed wake/status line ----
function updSum(){
  const sum = $('#sumBtn'); if (!sum) return;
  const [hh, mm] = ($('#wake').value || '05:00').split(':').map(Number), t12 = ((hh + 11) % 12 + 1) + ':' + String(mm).padStart(2, '0') + ' ' + (hh < 12 ? 'AM' : 'PM');
  const tone = ($('#msg').className.match(/warn|bad/) || ['ok'])[0], bar = $('#prog').querySelector('.pgBar i'), pt = $('#prog').querySelector('.pgT');
  sum.innerHTML = '<span class="sd ' + tone + '"></span><span class="sw">Wake ' + t12 + '</span><span class="sp">' + (bar ? '<span class="pgBar"><i style="width:' + bar.style.width + '"></i></span><span>' + pt.textContent + '</span>' : '') + '</span><svg class="ch" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
}
$('#sumBtn').addEventListener('click', () => { const o = $('#foldBox').classList.toggle('closed') === false; $('#sumBtn').setAttribute('aria-expanded', String(o)); store.set('wakeOpen', o); });
if (store.get('wakeOpen', false)){ $('#foldBox').classList.remove('closed'); $('#sumBtn').setAttribute('aria-expanded', 'true'); }
$('#wake').addEventListener('input', updSum);
$('#noteIc').innerHTML = ICONS.notebook;

// ---- first-run setup: a welcome screen, five steps, and a finish screen (full screen, like the tour) ----
const SU_SEG = [['early', 'sunrise', 'Early bird', '30 min earlier'], ['normal', 'sun', 'In between', 'As planned'], ['late', 'moon', 'Night owl', '45 min later']];
const SU_LISTS = { pre:['#cPre', '#su_pre', '#pvPre'], night:['#cNight', '#su_night', '#pvNight'] };
const SU_N = 5, SU_DONE = 6, SU_DAYS = [['M', 1], ['T', 2], ['W', 3], ['T', 4], ['F', 5], ['S', 6], ['S', 0]];
const SU_KINDS = [['work', 'Work', 'Days you head out to work'], ['school', 'School', 'Days you head out to school'], ['sick', 'Sick', 'Days you stay in and recover']];
let SU = {};
function suReset(){ SU = { step:0, sex:'', order:[], own:null, days:[1, 2, 3, 4, 5], rem:true, nud:true }; }
suReset();
// The logo from the tour, copied with its own ids so its gradients still work while the tour is closed.
function suLogo(){
  const src = document.querySelector('#welDlg .wlLogo'); if (!src) return '';
  return src.outerHTML.replace('class="wlLogo"', 'class="suLogoSvg"').replace(/id="([^"]+)"/g, 'id="$1_su"').replace(/url\(#([^)]+)\)/g, 'url(#$1_su)').replace(/href="#([^"]+)"/g, 'href="#$1_su"');
}
function setupPick(l, n){
  const [box, sel, pv] = SU_LISTS[l]; $(sel).value = n;
  [...$(box).children].forEach(x => x.classList.toggle('on', x.dataset.n === n));
  const st = n && TPL[l].sets[n];
  $(pv).innerHTML = st ? '<b>' + st.length + ' tasks, ' + st.reduce((a, t) => a + t[1], 0) + ' min.</b> ' + st.map(t => esc(t[0])).join(' · ') : 'Nothing added. You can build your own routine later.';
}
function suAgeHint(){
  const a = parseInt($('#su_age').value, 10), r = sleepRangeFor(a);
  $('#su_sleepHint').innerHTML = r ? 'Most people aged ' + a + ' do best with <b>' + r[0] + ' to ' + r[1] + ' hours</b> of sleep.' : '';
}
function suPreview(){
  const [h, m] = ($('#su_wake').value || '06:30').split(':').map(Number), w = h * 60 + m, sh = ({ early:-30, normal:0, late:45 })[$('#su_chrono').value] || 0;
  const keys = ['sleep', 'climb1', 'peak', 'trough', 'climb2', 'wmz', 'wind'];
  $('#su_dayBar').innerHTML = keys.map(k => '<i style="flex:' + (WIN[k].to - WIN[k].from) + ';background:' + WIN_STYLE[k].c + '"></i>').join('');
  $('#su_dayT').textContent = 'Your day from ' + clk(w);
  $('#su_dayA').textContent = clk(w); $('#su_dayB').textContent = clk(w + 1080);
  $('#su_dayP').innerHTML = 'Peak focus <b>' + clk(w + WIN.peak.from + sh) + ' to ' + clk(w + WIN.peak.to + sh) + '</b>';
}

// ---- day types: Home plus two more at most. Work and School share a slot; your own type takes Away's place. ----
function suPicks(){ return SU.order.map(k => k === 'own' ? { kind:'own', name:SU.own.name, icon:SU.own.icon } : { kind:k }); }
function suMsg(t){ const el = $('#su_typeMsg'); el.textContent = t || ''; el.hidden = !t; }
function suToggle(k){
  if (SU.order.includes(k)){ SU.order = SU.order.filter(x => x !== k); return; }
  if (k === 'work') SU.order = SU.order.filter(x => x !== 'school');      // one slot for both
  if (k === 'school') SU.order = SU.order.filter(x => x !== 'work');
  if (SU.order.length >= 2){ suMsg('Home plus two is the most. Untick one first.'); return; }
  SU.order.push(k);
}
function drawSuTypes(){
  const row = (k, name, sub, icon, on, edit) => '<div class="suTW"><button type="button" class="suT' + (on ? ' on' : '') + '" data-k="' + k + '" aria-pressed="' + on + '"><span class="suIc">' + icon + '</span><span class="suTx"><b>' + esc(name) + '</b><small>' + esc(sub) + '</small></span><span class="suCk"></span></button>' + (edit ? '<button type="button" class="suEdit" aria-label="Edit ' + esc(name) + '">Edit</button>' : '') + '</div>';
  $('#su_types').innerHTML = SU_KINDS.map(([k, n, sub]) => row(k, n, sub, dtIcon(n), SU.order.includes(k), false)).join('') +
    (SU.own ? row('own', SU.own.name, 'Your own', iconMarkup(SU.own.icon) || '', SU.order.includes('own'), true) : '<button type="button" class="add" id="su_addOwn">+ Add your own</button>');
  suOut();
}
function suOut(){
  const pl = planTypes(suPicks()), names = pl.names || ['Home', 'School', 'Away'], out = SU.order.find(k => k === 'work' || k === 'school');
  $('#su_sum').innerHTML = names.map(n => '<span>' + esc(n) + '</span>').join('');
  $('#su_outBox').hidden = !out;
  if (!out) return;
  const nm = out === 'work' ? 'Work' : 'School';
  $('#su_daysT').textContent = 'Usually ' + nm + ' on'; $('#su_leaveL').textContent = 'I leave for ' + nm + ' at';
  $('#su_days').innerHTML = SU_DAYS.map(([l, d]) => '<button type="button" data-d="' + d + '"' + (SU.days.includes(d) ? ' class="on"' : '') + ' aria-pressed="' + SU.days.includes(d) + '">' + l + '</button>').join('');
  suLeaveHint();
}
function suLeaveHint(){
  const el = $('#su_leaveHint'); if (!el) return;
  const lv = $('#su_leave').value, wv = $('#su_wake').value; if (!lv || !wv){ el.textContent = 'Leave it empty and those days run like Home. The morning routine shrinks to finish before this time.'; return; }
  const [lh, lm] = lv.split(':').map(Number), [wh, wm] = wv.split(':').map(Number), d = ((lh * 60 + lm) - (wh * 60 + wm)) / 60;
  el.innerHTML = d > 0 ? 'That is <b>' + d.toFixed(1) + ' h after you wake</b>. The morning routine shrinks to finish before it.' : 'That is before your wake time, so those mornings would have no room.';
}
$('#su_types').addEventListener('click', e => {
  if (e.target.closest('.suEdit')){ suOwnOpen(true); return; }
  if (e.target.closest('#su_addOwn')){ if (SU.order.length >= 2){ suMsg('Home plus two is the most. Untick one first.'); return; } suMsg(''); suOwnOpen(false); return; }
  const b = e.target.closest('.suT'); if (!b) return;
  suMsg(''); suToggle(b.dataset.k); drawSuTypes();
});
$('#su_days').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const d = Number(b.dataset.d); SU.days = SU.days.includes(d) ? SU.days.filter(x => x !== d) : SU.days.concat(d); suOut(); });

// ---- your own day type: a name and an icon, kept as a draft until you finish setup ----
let suOwnIcon = 'star', suOwnEditing = false;
function suOwnIconBtn(){ $('#so_iconBtn').innerHTML = iconMarkup(suOwnIcon) || '+'; }
function suOwnOpen(editing){
  suOwnEditing = editing; suOwnIcon = editing ? SU.own.icon : 'star'; suOwnIconBtn();
  $('#so_t').value = editing ? SU.own.name : ''; $('#so_err').hidden = true; $('#so_del').hidden = !editing; $('#so_title').textContent = editing ? 'Edit your day type' : 'Add your own';
  $('#suOwnDlg').showModal(); $('#so_t').focus(); setTimeout(() => $('#so_t').focus(), 80);
}
$('#so_iconBtn').addEventListener('click', () => {
  ipTarget = v => { suOwnIcon = v || 'star'; suOwnIconBtn(); };
  $('#e_icon_custom').value = suOwnIcon && !ICONS[suOwnIcon] ? suOwnIcon : ''; $('#ip_q').value = ''; drawIconPicker('');
  $('#iconPick').showModal(); $('#ip_scroll').scrollTop = 0; ipSpy();
});
function suOwnSave(){
  const err = ownNameError($('#so_t').value);
  if (err){ $('#so_err').textContent = err; $('#so_err').hidden = false; return; }
  SU.own = { name:$('#so_t').value.trim().replace(/\s+/g, ' '), icon:suOwnIcon };
  if (!SU.order.includes('own') && SU.order.length < 2) SU.order.push('own');
  $('#suOwnDlg').close(); drawSuTypes();
}
$('#so_ok').onclick = suOwnSave; $('#so_x').onclick = () => $('#suOwnDlg').close();
$('#so_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); suOwnSave(); } });
$('#so_del').onclick = () => { SU.own = null; SU.order = SU.order.filter(k => k !== 'own'); $('#suOwnDlg').close(); suMsg(''); drawSuTypes(); };

// ---- about you ----
function suAgeStep(d){
  const v = parseInt($('#su_age').value, 10); let n;
  if (!Number.isFinite(v)){ if (d < 0) return; n = 1; } else n = v + d;       // an empty age starts at 1
  $('#su_age').value = Math.max(1, Math.min(110, n)); suAgeHint();
}
function suHold(btn, d){      // tap for one step, hold to keep counting
  let t1, t2; const stop = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', e => { if (e.button) return; suAgeStep(d); t1 = setTimeout(() => { t2 = setInterval(() => suAgeStep(d), 70); }, 420); });
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev => btn.addEventListener(ev, stop));
  btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); suAgeStep(d); } });
  btn.addEventListener('contextmenu', e => e.preventDefault());
}
suHold($('#su_ageM'), -1); suHold($('#su_ageP'), 1);
$('#su_age').addEventListener('input', suAgeHint);
$('#su_sex').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; SU.sex = SU.sex === b.dataset.v ? '' : b.dataset.v; [...$('#su_sex').children].forEach(x => x.classList.toggle('on', x.dataset.v === SU.sex)); });

// ---- wake time, routines, bedtime ----
function drawSetup(){
  $('#cSeg').innerHTML = SU_SEG.map(([v, i, n, sub]) => '<button type="button" data-v="' + v + '"' + ($('#su_chrono').value === v ? ' class="on"' : '') + '>' + ICONS[i] + n + '<small>' + sub + '</small></button>').join('');
  Object.keys(SU_LISTS).forEach(l => {
    $(SU_LISTS[l][0]).innerHTML = [''].concat(Object.keys(TPL[l].sets)).map(n => '<button type="button" data-n="' + esc(n) + '">' + (n ? esc(n) : 'Start empty') + '</button>').join('');
    setupPick(l, $(SU_LISTS[l][1]).value);
  });
}
$('#cSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $('#su_chrono').value = b.dataset.v; [...$('#cSeg').children].forEach(x => x.classList.toggle('on', x === b)); suPreview(); });
Object.keys(SU_LISTS).forEach(l => $(SU_LISTS[l][0]).addEventListener('click', e => { const b = e.target.closest('button'); if (b) setupPick(l, b.dataset.n); }));
$('#su_wake').addEventListener('change', () => { suPreview(); suLeaveHint(); });
$('#su_leave').addEventListener('change', suLeaveHint);
// Bedtime is optional. It becomes the hard cap (lights out), with the soft cap an hour earlier. Caps start at 6:00 PM, so a bedtime before 6:30 PM is skipped.
function suBedHint(){
  const v = $('#su_bed').value, h = $('#su_bedHint'); if (!h) return;
  const [bh, bm] = v ? v.split(':').map(Number) : [0, 0];
  h.textContent = !v ? 'Optional. Sets your sleep caps: this time is lights out, and wrap-up starts an hour before. Leave it empty to skip.'
    : bh * 60 + bm < 18 * 60 + 30 ? 'Sleep caps start at 6:30 PM or later, so this one will be skipped.' : 'Lights out at this time, with wrap-up starting an hour before.';
}
$('#su_bed').addEventListener('change', suBedHint);
function suApplyBed(){
  const v = $('#su_bed').value; if (!v) return;
  const [bh, bm] = v.split(':').map(Number), hard = bh * 60 + bm;
  if (hard < 18 * 60 + 30) return;
  CAP.hard = hard; CAP.soft = hard - 60; capDraft = { soft:CAP.soft, hard:CAP.hard }; store.set('caps', { soft:CAP.soft, hard:CAP.hard });
}

// ---- reminders ----
function suSwitch(id, key){ $(id).addEventListener('click', () => { SU[key] = !SU[key]; $(id).setAttribute('aria-checked', String(SU[key])); suShow(SU.step); }); }
suSwitch('#su_remB', 'rem'); suSwitch('#su_nudB', 'nud');
async function suPerm(){
  if (IS_NATIVE){ const LN = nativePlugin('LocalNotifications'); try{ let p = await LN.checkPermissions(); if (p.display !== 'granted') p = await LN.requestPermissions(); return p.display === 'granted'; }catch{ return false; } }
  if ('Notification' in window){ try{ return (Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()) === 'granted'; }catch{ return false; } }
  return false;
}

// ---- moving between screens ----
function suShow(n){
  SU.step = n;
  document.querySelectorAll('#setupDlg .suStep').forEach(x => { x.hidden = Number(x.dataset.s) !== n; });
  const mid = n >= 1 && n <= SU_N; $('#su_top').hidden = !mid;
  if (mid){ $('#su_stepTxt').textContent = 'Step ' + n + ' of ' + SU_N; $('#su_bar').style.width = (n / SU_N * 100) + '%'; }
  $('#su_ok').textContent = n === 0 ? 'Get started' : n < SU_N ? 'Continue' : n === SU_N ? (SU.rem || SU.nud ? 'Turn on and finish' : 'Finish') : 'Take the welcome tour';
  $('#su_skip').textContent = n === 0 ? 'Skip setup' : n === SU_DONE ? 'Skip the tour' : 'Back';
  if (n === 2) suPreview(); if (n === 3) drawSuTypes(); if (n === 4) suBedHint();
  $('#su_body').scrollTop = 0;
}
function openSetup(){
  suReset();
  const opt = l => '<option value="">Start empty</option>' + Object.keys(TPL[l].sets).map(n => '<option>' + n + '</option>').join('');
  $('#su_pre').innerHTML = opt('pre'); $('#su_night').innerHTML = opt('night');
  $('#su_logo').innerHTML = suLogo();
  $('#su_bed').value = capsOn() ? toVal(CAP.hard) : ''; suBedHint();
  [...$('#su_sex').children].forEach(x => x.classList.remove('on')); $('#su_remB').setAttribute('aria-checked', 'true'); $('#su_nudB').setAttribute('aria-checked', 'true');
  $('#su_icRem').innerHTML = ICONS.bell; $('#su_icNud').innerHTML = ICONS.heartbeat;
  drawSetup(); suAgeHint(); suShow(0); if (EDUI) EDUI.enhanceTimes($('#setupDlg'));
  $('#setupDlg').showModal(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
// Turn the day type choices into the app's own settings: which slots are renamed, their icons, the usual days and the leave time.
function suApplyTypes(){
  const plan = planTypes(suPicks()); if (plan.error) return;
  store.set('slotNames', plan.slotNames);
  if (Object.keys(plan.icons).length) store.set('typeIcons', { ...(store.get('typeIcons', {}) || {}), ...plan.icons });
  syncTypes();
  LEAVE_FOR = 'school'; store.set('leaveFor', LEAVE_FOR);
  const lv = $('#su_leave').value; LEAVE = plan.main && lv ? Number(lv.split(':')[0]) * 60 + Number(lv.split(':')[1]) : null; store.set('leave', LEAVE);
  if (plan.main && SU.days.length){ const U = { ...store.get('usual', {}) }; SU.days.forEach(d => { U[d] = plan.main; }); store.set('usual', U); }
  applyLeave(); drawDayTypes(); drawUsual(); drawLeave();
}
async function suFinish(){
  $('#su_ok').disabled = true;
  try{
    const nm = $('#su_name').value.trim().replace(/\s+/g, ' ').slice(0, 30), age = parseInt($('#su_age').value, 10);
    store.set('profile', { name:nm, age:age >= 1 && age <= 110 ? age : null, sex:SU.sex || null });
    const [h, m] = ($('#su_wake').value || '06:30').split(':').map(Number);
    suApplyBed();
    store.set('wake', h * 60 + m); store.set('chrono', $('#su_chrono').value); syncChrSel();
    suApplyTypes();
    if ($('#su_pre').value) tplApply('pre', $('#su_pre').value);
    if ($('#su_night').value) tplApply('night', $('#su_night').value);
    if (SU.rem || SU.nud){
      const ok = await suPerm();
      const R = store.get('rem', { on:false, lead:0 }); if (SU.rem) R.on = ok; store.set('rem', R);
      const N = { ...store.get('enNudge', {}) }; if (SU.nud) N.on = ok; store.set('enNudge', N);
      if (IS_NATIVE){ try{ await remNativeState(); remSoon(true); }catch{} } else if ($('#remCard')) $('#remCard').innerHTML = remCard();
      if (!ok) toast('Notifications are off. You can turn them on in Settings, Reminders.');
    }
  }finally{ $('#su_ok').disabled = false; }
  store.set('setup', true); store.set('capsNote', true); goDate(todayStr()); drawProfile(); suShow(SU_DONE);
}
function suEnd(tour){
  store.set('setup', true); store.set('capsNote', true); if (!tour) store.set('welcomed', true);
  $('#setupDlg').close(); goDate(todayStr()); drawProfile(); if (tour) openWelcome(true);
}
$('#su_ok').onclick = () => { if (SU.step < SU_N) suShow(SU.step + 1); else if (SU.step === SU_N) suFinish(); else suEnd(true); };
$('#su_skip').onclick = () => { if (SU.step === 0){ store.set('setup', true); store.set('capsNote', true); suShow(SU_DONE); } else if (SU.step === SU_DONE) suEnd(false); else suShow(SU.step - 1); };

// ---- Settings, Profile ----
const PF_SEX = [['m', 'Male'], ['f', 'Female'], ['n', 'Prefer not to say']];
$('#tab-settings').insertAdjacentHTML('beforeend', '<div class="sleep"><h2>Profile</h2><p class="wn">Used to suggest sensible defaults. It stays on this device.</p><div id="pfBox"></div></div>');
function drawProfile(){
  const P = store.get('profile', {}) || {};
  $('#pfBox').innerHTML = '<div><label for="pfName">Name</label><input class="pfIn" id="pfName" type="text" maxlength="30" autocomplete="off" value="' + esc(P.name || '') + '" placeholder="Your name"></div>' +
    '<div><label for="pfAge">Age</label><input class="pfIn" id="pfAge" type="number" inputmode="numeric" min="1" max="110" value="' + (Number.isFinite(P.age) ? P.age : '') + '" placeholder="Age"></div>' +
    '<div><label>Sex</label><div class="pfSex" id="pfSex">' + PF_SEX.map(([v, n]) => '<button type="button" data-v="' + v + '"' + (P.sex === v ? ' class="on"' : '') + '>' + n + '</button>').join('') + '</div></div>';
}
function pfSave(patch){ const P = { ...(store.get('profile', {}) || {}), ...patch }; store.set('profile', P); updateSettingsValues(); }
$('#pfBox').addEventListener('change', e => {
  if (e.target.id === 'pfName') pfSave({ name:e.target.value.trim().replace(/\s+/g, ' ').slice(0, 30) });
  if (e.target.id === 'pfAge'){ const a = parseInt(e.target.value, 10); pfSave({ age:a >= 1 && a <= 110 ? a : null }); }
});
$('#pfBox').addEventListener('click', e => { const b = e.target.closest('#pfSex button'); if (!b) return; const P = store.get('profile', {}) || {}; pfSave({ sex:P.sex === b.dataset.v ? null : b.dataset.v }); drawProfile(); });
drawProfile();

// ============================================================
// SCOPED EDITS, MOVE / COPY, COPY DAY, RUNNING LATE
// ============================================================
function diffBlock(o, n){
  const nd = x => { const y = { ...x }; if (Array.isArray(y.days) && y.days.length === 7) delete y.days; return y; };
  o = nd(o); n = nd(n);
  const p = {};
  new Set([...Object.keys(o), ...Object.keys(n)]).forEach(k => {
    if (k !== 'id' && JSON.stringify(o[k]) !== JSON.stringify(n[k])) p[k] = n[k] === undefined ? null : n[k];
  });
  return p;
}
let scopeCtx = null, scDays = [], scModes = [], scFrom = '', scTo = '';
function drawScChips(){
  $('#sc_days').innerHTML = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((n, i) => '<button type="button" data-i="' + i + '"' + (scDays.includes(i) ? ' class="on"' : '') + '>' + n + '</button>').join('');
  $('#sc_modes').innerHTML = WIN_LISTS.map(m => '<button type="button" data-m="' + m + '"' + (scModes.includes(m) ? ' class="on"' : '') + '>' + MODE_LABEL[m] + ' days</button>').join('');
}
function askScope(type, ctx){
  scopeCtx = { type, ...ctx }; scDays = []; scModes = [];
  const when = parseDay(viewDate).toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  $('#sc_h').textContent = type === 'reset' ? 'Reset this block for' : type === 'delete' ? 'Delete this task for' : type === 'add' ? 'Add this task to' : 'Apply this change to';
  $('#sc_opts').innerHTML = [['day', 'Only this day (' + when + ')'], ['from', 'This day and the days after'], ['all', 'All days']].map(a => '<button data-sc="' + a[0] + '">' + a[1] + '</button>').join('');
  $('#sc_modes').style.display = (ctx.l === 'pre' || ctx.l === 'night') ? '' : 'none';
  $('#sc_range').style.display = (type === 'reset' || ctx.l === 'win') ? 'none' : '';       // dates are for tasks
  $('#sc_from').value = viewDate; $('#sc_to').value = '';
  { const tn = $('#sc_typesNote'), ts = ctx.types && type !== 'delete' ? ctx.types : null; tn.style.display = ts ? '' : 'none'; if (ts) tn.textContent = 'Day types: ' + ts.map(m => MODE_LABEL[m]).join(', ') + '. This applies to the options below, except "Only this day".'; }
  drawScChips(); $('#scopeDlg').showModal();
}
function applyScope(sc){ const _s = grab(), ty = scopeCtx && scopeCtx.type; needLive(); applyScope0(sc); showUndo(ty === 'delete' ? 'Task deleted' : ty === 'add' ? 'Task added' : 'Task updated', _s); }
// ---- deleting: must always work, whatever state an older version left the task in ----
function removeFromRoutines(c){
  const all = {}; TASK_LISTS.forEach(l => { all[l] = getBlocks(l); });
  const r = removeTask(all, { ...c, ...rowInfo(c.id) });
  if (r.list) setBlocks(r.list, r.blocks[r.list]);
  return !!r.list;
}
function rowInfo(id){ const r = schedule().rows.find(x => sameId(x.id, id)); return r ? { t: r.t, w: r.w } : {}; }
// A past day shows a frozen record of what was there. Deleting from it removes that entry from the record.
async function deleteFromRecord(c){
  if (!await ask('Remove this task from the record of this day?', { ok:'Remove', danger:true })) return;
  const _s = grab(), H = store.get('hist', {}), rec = H[viewDate], next = removeFromRecord(rec, { id: c.id, ...rowInfo(c.id) });
  if (next !== rec){ H[viewDate] = next; store.set('hist', H); }
  render(); showUndo('Task removed', _s);
}
// A task that is on screen but no longer in any routine.
function ghostDelete(l, id){
  if (snapMode()){ deleteFromRecord({ l, id }); return; }
  const _s = grab(); needLive();
  if (l === 'oo') setBlocks('oo', clone(getBlocks('oo')).filter(x => !sameId(x.id, id))); else removeFromRoutines({ l, id });
  render(); showUndo('Task deleted', _s);
}
function applyScope0(sc){
  const c = scopeCtx; if (!c) return;
  if (c.l === 'win'){ applyWinScope(sc, c); return; }
  const iso = viewDate, filt = {}, OV = store.get('ovr', {}), arr = clone(getBlocks(c.l));
  if (scDays.length) filt.days = scDays.slice().sort();
  if (scModes.length && (c.l === 'pre' || c.l === 'night')) filt.modes = scModes.slice();
  const hasFilt = !!(filt.days || filt.modes), push = (id, e) => { (OV[id] = OV[id] || []).push(e); };
  const range_ = sc === 'range' ? { from:scFrom || null, to:scTo || null } : { from:sc === 'all' ? null : iso, to:sc === 'day' ? iso : null };
  const stamp = o => { if (sc === 'from') o.from = (o.from && o.from > iso) ? o.from : iso; else if (sc === 'range'){ if (scFrom) o.from = scFrom; if (scTo) o.to = scTo; } return o; };   // the dates a new task carries
  if (c.type === 'add'){
    if (sc === 'day'){
      const o = { ...c.b, w:c.w || (c.l === 'pre' ? 'sleep' : c.l === 'night' ? 'wind' : 'climb1') };
      delete o.days; delete o.modes;
      day.oneoffs = (day.oneoffs || []).concat(o); saveDay();
    } else {
      const types = (c.types && c.types.length) ? c.types : [c.l], lk = types.length > 1 ? (c.b.lk || 'k' + c.id) : c.b.lk;
      types.forEach((tp, i) => {
        const b = stamp({ ...c.b, ...filt }); if (lk) b.lk = lk; if (i > 0) b.id = newTaskId(i);
        const a = tp === c.l ? arr : clone(getBlocks(tp)); a.push(b); setBlocks(tp, a);
      });
      if (c.l !== 'pre' && c.l !== 'night' && c.w && !typeOf(c.w) && types.includes(c.l)){ day.types[c.w] = c.l; saveDay(); }
    }
  } else if (c.type === 'delete'){
    if (sc === 'all' && !hasFilt){ removeFromRoutines(c); delete OV[c.id]; }
    else push(c.id, { ...range_, ...filt, patch:null });
  } else {
    const patch = diffBlock(c.old, c.b);
    const dp = {}; ['from', 'to'].forEach(k => { if (k in patch){ dp[k] = patch[k]; delete patch[k]; } });
    if (Object.keys(dp).length){                 // start and end dates belong to the task itself, whatever days the rest of the edit covers
      const bi0 = arr.findIndex(x => sameId(x.id, c.id)), lk0 = bi0 >= 0 ? arr[bi0].lk : null;
      const put = x => { const nb = { ...x }; Object.keys(dp).forEach(k => { if (dp[k] === null) delete nb[k]; else nb[k] = dp[k]; }); return nb; };
      if (bi0 >= 0) arr[bi0] = put(arr[bi0]);
      setBlocks(c.l, arr);
      if (lk0) WIN_LISTS.forEach(L => { if (L !== c.l) setBlocks(L, clone(getBlocks(L)).map(x => x.lk === lk0 ? put(x) : x)); });
    }
    if (Object.keys(patch).length){
      if (sc === 'all' && !hasFilt){
        { const bi = arr.findIndex(x => sameId(x.id, c.id)), nb = { ...arr[bi] }; Object.keys(patch).forEach(k => { if (patch[k] === null) delete nb[k]; else nb[k] = patch[k]; }); arr[bi] = nb; } setBlocks(c.l, arr);
        (OV[c.id] || []).forEach(e => { if (e.patch) Object.keys(patch).forEach(k => delete e.patch[k]); });
        OV[c.id] = (OV[c.id] || []).filter(e => e.patch === null || Object.keys(e.patch).length);
        if (!OV[c.id].length) delete OV[c.id];
      } else push(c.id, { ...range_, ...filt, patch });
    }
    if (c.types && WIN_LISTS.includes(c.l) && sc !== 'day'){
      const base = getBlocks(c.l).find(x => sameId(x.id, c.id)) || {}, copies = {};
      WIN_LISTS.forEach(L => { if (L !== c.l && base.lk){ const x = getBlocks(L).find(y => y.lk === base.lk); if (x) copies[L] = x; } });
      const have = [c.l, ...Object.keys(copies)], toAdd = c.types.filter(t => !have.includes(t)), toDrop = have.filter(t => !c.types.includes(t));
      let lk = base.lk;
      if (!lk && toAdd.length){ lk = 'k' + c.id; setBlocks(c.l, getBlocks(c.l).map(x => sameId(x.id, c.id) ? { ...x, lk } : x)); }
      const whole = sc === 'all' && !hasFilt, pt = { ...patch }; delete pt.lk;
      Object.keys(copies).forEach(L => {                       // copies that stay: carry the change over
        if (toDrop.includes(L) || !Object.keys(pt).length) return;
        if (whole) setBlocks(L, clone(getBlocks(L)).map(x => { if (x.id !== copies[L].id) return x; const nb = { ...x }; Object.keys(pt).forEach(k => { if (pt[k] === null) delete nb[k]; else nb[k] = pt[k]; }); return nb; }));
        else push(copies[L].id, { ...range_, ...filt, patch: { ...pt } });
      });
      toDrop.forEach(L => {                                    // unticked types: remove that copy
        const id = L === c.l ? c.id : copies[L].id;
        if (whole){ setBlocks(L, clone(getBlocks(L)).filter(x => !sameId(x.id, id))); delete OV[id]; }
        else push(id, { ...range_, ...filt, patch:null });
      });
      toAdd.forEach((L, i) => {                                // newly ticked types: add a copy
        const cp = stamp({ ...c.b, ...filt, id: newTaskId(i + 1), lk });
        const a = clone(getBlocks(L)); a.push(cp); setBlocks(L, a);
      });
    }
  }
  store.set('ovr', OV); scopeCtx = null; $('#scopeDlg').close(); $('#ed').close(); render();
}
$('#sc_days').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const i = Number(b.dataset.i); scDays = scDays.includes(i) ? scDays.filter(x => x !== i) : scDays.concat(i); drawScChips(); });
$('#sc_modes').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const m = b.dataset.m; scModes = scModes.includes(m) ? scModes.filter(x => x !== m) : scModes.concat(m); drawScChips(); });
$('#sc_opts').addEventListener('click', e => { const b = e.target.closest('button'); if (b) applyScope(b.dataset.sc); });
$('#sc_range_ok').onclick = () => {
  const f = $('#sc_from').value, t = $('#sc_to').value;
  if (!f && !t){ tell('Pick a start date, an end date, or both.'); return; }
  if (f && t && t < f){ tell('The end date is before the start date.'); return; }
  scFrom = f; scTo = t; applyScope('range');
};
$('#sc_x').onclick = () => $('#scopeDlg').close();
$('#e_del').onclick = () => {
  if (cur.l === 'oo'){ const _s = grab(); needLive(); setBlocks('oo', clone(getBlocks('oo')).filter(x => !sameId(x.id, cur.id))); $('#ed').close(); render(); showUndo('Task deleted', _s); return; }
  askScope(cur.l === 'win' ? 'reset' : 'delete', { l:cur.l, id:cur.id });
};
$('#ts_del').onclick = async () => {
  if (snapMode()){ $('#taskSheet').close(); deleteFromRecord(sheetCtx); return; }
  if (sheetCtx.l === 'oo'){ if (!await ask('Delete this task?', { ok:'Delete', danger:true })) return; const _s = grab(); needLive(); setBlocks('oo', clone(getBlocks('oo')).filter(x => !sameId(x.id, sheetCtx.id))); $('#taskSheet').close(); render(); showUndo('Task deleted', _s); return; }
  $('#taskSheet').close(); askScope('delete', { l:sheetCtx.l, id:sheetCtx.id });
};

// ---- move / copy a task, copy a day ----
function addOneOff(ds, o){
  if (ds === viewDate){ day.oneoffs = (day.oneoffs || []).concat(o); saveDay(); return; }
  const p = plans[ds] || planFor(ds) || { w:defWake(), d:[], t:{}, a:false, n:'' };
  p.o = (p.o || []).concat(o); plans[ds] = p; store.set('plans', plans);
}
let mvMode = 'task', shBy = 15;
let mvMon = '';
$('#mv_wd').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => '<span>' + n + '</span>').join('');
function mvLabel(){
  const ds = mvDate(), nm = ds ? parseDay(ds).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' }) : '';
  $('#mv_go').textContent = (mvMode === 'day' ? 'Copy to ' : 'Move to ') + nm;
}
function drawMv(){
  const td = todayStr(), g = monthGrid(mvMon), sel = mvDate();
  $('#mv_mon').textContent = parseDay(mvMon).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  $('#mv_grid').innerHTML = '<span></span>'.repeat(g.lead) + g.days.map(iso => {
    const mt = dayMeta(iso);
    return '<button type="button" class="dpD jd' + (iso === td ? ' today' : '') + (iso === sel ? ' sel' : '') + (iso < td ? ' past' : '') + (mt.away ? ' away' : '') + '" data-d="' + iso + '" aria-label="' + esc(parseDay(iso).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })) + '">' + parseDay(iso).getDate() + (mt.note ? '<b class="jdn"></b>' : '') + '</button>';
  }).join('');
  [...$('#mv_chips').children].forEach(b => b.classList.toggle('on', sel === addDays(viewDate, Number(b.dataset.n))));
  mvLabel();
}
function mvPick(iso){ $('#mv_d').value = iso; mvMon = iso.slice(0, 7) + '-01'; drawMv(); }
$('#mv_grid').addEventListener('click', e => { const b = e.target.closest('button'); if (b) mvPick(b.dataset.d); });
$('#mv_chips').addEventListener('click', e => { const b = e.target.closest('button'); if (b) mvPick(addDays(viewDate, Number(b.dataset.n))); });
$('#mv_prev').onclick = () => { mvMon = shiftMonth(mvMon, -1); drawMv(); };
$('#mv_next').onclick = () => { mvMon = shiftMonth(mvMon, 1); drawMv(); };
function openMv(mode){
  mvMode = mode;
  $('#mv_t').value = '';
  $('#mv_h').textContent = mode === 'day' ? 'Copy this day' : 'Move or copy to';
  ['mv_tw', 'mv_inbox', 'mv_copy'].forEach(i => { $('#' + i).style.display = mode === 'day' ? 'none' : ''; });
  mvPick(addDays(viewDate, 1));
  $('#mvDlg').showModal();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function mvDate(){ const v = $('#mv_d').value; if (!v) return null; const [y, m, d] = v.split('-').map(Number); return isoLocal(new Date(y, m - 1, d)); }
function mvDo(kind){ const _s = grab(); needLive(); mvDo0(kind); showUndo(kind === 'copy' ? 'Copied' : kind === 'inbox' ? 'Moved to inbox' : 'Moved', _s); }
function mvDo0(kind){
  const r = schedule().rows.find(x => sameId(x.id, sheetCtx.id)); if (!r) return;
  const ds = kind === 'inbox' ? null : mvDate(); if (kind !== 'inbox' && !ds) return;
  const o = { id:'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t:r.t, d:r.d !== undefined ? r.d : r.use };
  ['m', 'p', 'sug', 'icon', 'color', 'details', 'steps', 'fixed', 'at'].forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
  const tm = $('#mv_t').value;
  if (tm){ const [h, mi] = tm.split(':').map(Number); o.fixed = h * 60 + mi; if (!o.d) o.d = 20; }
  if (ds) o.w = o.fixed !== undefined ? winFor(o.fixed, (planFor(ds) || {}).w ?? defWake()) : (r.w || 'climb1');
  const removeHere = () => {
    if (sheetCtx.l === 'oo') day.oneoffs = (day.oneoffs || []).filter(x => !sameId(x.id, sheetCtx.id));
    else { const OV = store.get('ovr', {}), iso = viewDate; (OV[sheetCtx.id] = OV[sheetCtx.id] || []).push({ from:iso, to:iso, patch:null }); store.set('ovr', OV); }
  };
  if (kind === 'inbox'){ store.set('inbox', insertNew(store.get('inbox', []), makeTask(r.t, { note:r.details }))); removeHere(); }
  else { if (kind === 'move') removeHere(); addOneOff(ds, o); }
  saveDay(); $('#mvDlg').close(); render();
}
function copyDay(src, dst){
  const p = src === viewDate ? { w:wake, t:day.types, a:day.away, o:day.oneoffs || [], s:day.shift } : (planFor(src) || {});
  plans[dst] = { w:p.w ?? defWake(), d:[], t:{ ...(p.t || {}) }, a:!!p.a, n:'', p:null, o:(p.o || []).map(x => ({ ...x, id:x.id + 'c' + Math.random().toString(36).slice(2, 5) })), l:false, s:p.s || null };
  const OV = store.get('ovr', {}), si = src, di = dst;
  Object.keys(OV).forEach(id => OV[id].filter(e => e.from === si && e.to === si).forEach(e => OV[id].push({ ...e, from:di, to:di })));
  store.set('ovr', OV); store.set('plans', plans);
}
$('#ts_move').onclick = () => { $('#taskSheet').close(); openMv('task'); };
$('#mv_go').onclick = async () => {
  if (mvMode === 'task'){ mvDo('move'); return; }
  const ds = mvDate(); if (!ds) return;
  if (ds === viewDate){ tell('Pick a different day.'); return; }
  if (plans[ds] && !await ask('That day already has a plan. Replace it?', { ok:'Replace', danger:true })) return;
  const _s = grab(); copyDay(viewDate, ds); $('#mvDlg').close(); goDate(ds); showUndo('Day copied', _s);
};
$('#mv_copy').onclick = () => mvDo('copy');
$('#mv_inbox').onclick = () => mvDo('inbox');
$('#mv_x').onclick = () => $('#mvDlg').close();

// ---- running late ----
function openShift(){
  shBy = day.shift ? day.shift.by : 15;
  $('#sh_from').value = toVal(day.shift ? day.shift.from : (viewDate === todayStr() ? nowM() : wake));
  document.querySelectorAll('#sh_chips button').forEach(b => b.classList.toggle('on', Number(b.dataset.m) === shBy));
  $('#sh_clear').style.visibility = day.shift ? '' : 'hidden';
  shUpd();
  $('#shDlg').showModal();
}
function shUpd(){ const n = shBy === 60 ? '1 hour' : shBy + ' min'; $('#sh_ok').textContent = 'Push my day ' + n + ' later'; const v = $('#sh_from').value; $('#sh_prev').textContent = v ? 'Everything from ' + fmt(Number(v.split(':')[0]) * 60 + Number(v.split(':')[1])).join(' ') + ' moves ' + n + ' later.' : ''; }
$('#sh_from').addEventListener('input', shUpd);
$('#sh_chips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; shBy = Number(b.dataset.m); document.querySelectorAll('#sh_chips button').forEach(x => x.classList.toggle('on', x === b)); shUpd(); });
$('#sh_ok').onclick = () => { const [h, m] = ($('#sh_from').value || '00:00').split(':').map(Number); needLive(); day.shift = { from:h * 60 + m, by:shBy }; saveDay(); $('#shDlg').close(); render(); };
$('#sh_clear').onclick = () => { needLive(); day.shift = null; saveDay(); $('#shDlg').close(); render(); };
$('#sh_x').onclick = () => $('#shDlg').close();

// ============================================================
// UNDO + TOASTS, USUAL DAYS, ENERGY CHECK-INS, TASK INSIGHTS,
// ANY-TASK TIMER, WEEKLY REVIEW, SHARE BACKUP, DRAG AND DROP
// ============================================================
function hideToast(){ clearTimeout(toastT); toastUntil = 0; $('#toast').classList.remove('show'); }
function toast(msg, label, fn){
  clearTimeout(toastT);
  toastUntil = Date.now() + 7000; toastShownAt = Date.now();
  toastT = setTimeout(hideToast, 7000);                 // timer first, so nothing below can leave a toast stuck on screen
  $('#toastMsg').textContent = msg;
  const b = $('#toastBtn'); b.style.display = label ? '' : 'none'; b.textContent = label || '';
  b.onclick = () => { hideToast(); if (fn) fn(); };
  $('#toast').classList.add('show');
}
// Safety nets: a toast can never outlive its time, even if the phone paused the timer; tapping the message dismisses it.
setInterval(() => { if (toastUntil && Date.now() > toastUntil + 300) hideToast(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && toastUntil && Date.now() >= toastUntil) hideToast(); });
$('#toast').addEventListener('click', e => { if (e.target.id !== 'toastBtn') hideToast(); });
const UNDO_KEYS = ['blocks', 'ovr', 'plans', 'inbox', 'todos', 'todoLists', 'todoTags', 'todoPrefs', 'todoLog', 'taskNotes', 'hist', 'wins', 'wovr'];
function grab(){ const s = {}; UNDO_KEYS.forEach(k => { s[k] = store.raw(k); }); return s; }
function showUndo(msg, s){
  toast(msg, 'Undo', () => {
    UNDO_KEYS.forEach(k => store.setRaw(k, s[k]));
    plans = store.get('plans', {}); loadDay(viewDate); render();
  });
}

function usualTypes(ds){
  const m = store.get('usual', {})[dowOf(ds)]; if (!m) return {};
  const t = {}; ['climb1', 'peak', 'trough', 'climb2', 'wmz'].forEach(k => { t[k] = k === 'wmz' && m === 'school' ? 'home' : m; }); return t;
}
function drawUsual(){
  const U = store.get('usual', {}), nm = Object.assign({ '': 'None' }, MODE_LABEL);
  $('#usualGrid').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(i => '<button class="uwb" data-i="' + i + '"><b>' + ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][i] + '</b><span>' + (nm[U[i] || ''] || 'None') + '</span></button>').join('');
}
$('#tab-settings').insertAdjacentHTML('beforeend', '<div class="sleep"><h2>Usual days</h2><p class="wn">Tap a weekday to set where you usually are. New days start with it already picked.</p><div class="wk" id="usualGrid"></div></div>');
drawUsual();
$('#usualGrid').addEventListener('click', e => {
  const b = e.target.closest('.uwb'); if (!b) return;
  const U = store.get('usual', {}), order = [''].concat(WIN_LISTS), i = b.dataset.i;
  U[i] = order[(order.indexOf(U[i] || '') + 1) % order.length]; if (!U[i]) delete U[i];
  store.set('usual', U); drawUsual();
});


// ---- Settings: Day types ----
$('#tab-settings').insertAdjacentHTML('beforeend', '<div class="sleep"><h2>Day types</h2><p class="wn">Home, School and Away are built in. Tap School or Away to swap it for Work or Sick, or add your own day type. They appear in every block of the day, and tasks can be added to any of them.</p><div id="dtList"></div><button type="button" class="add" id="dtAdd">+ Add a day type</button></div>');
const DT_ICON = { Home:'home', School:'student', Away:'suitcase', Work:'briefcase', Sick:'thermometer' };
const dtIcon = n => iconMarkup((store.get('typeIcons', {}) || {})[n] || DT_ICON[n] || 'star') || '';
function drawDayTypes(){
  const cs = dayTypes();
  const row = (attrs, name, sub, chip) => '<' + (chip ? 'button type="button"' : 'div') + ' class="dtI"' + attrs + '><span class="dtIc">' + dtIcon(name) + '</span><span class="dtT"><b>' + esc(name) + '</b><small>' + sub + '</small></span>' + (chip ? '<span class="dtChip">' + chip + '</span>' : '') + '</' + (chip ? 'button' : 'div') + '>';
  $('#dtList').innerHTML = row('', 'Home', 'Built in', '') + row(' data-slot="school"', BUILTIN_TYPES.school, 'Built in', 'Swap') + row(' data-slot="away"', BUILTIN_TYPES.away, 'Built in', 'Swap') + cs.map(t => row(' data-dt="' + t.id + '"', t.name, 'Your own', 'Edit')).join('');
  $('#dtAdd').disabled = cs.length >= 8; $('#dtAdd').textContent = cs.length >= 8 ? 'You can have up to 8 of your own' : '+ Add a day type';
}
drawDayTypes();
let dtEdit = null, dtIc = '';
function dtIconBtn(){ $('#dt_iconBtn').innerHTML = dtIc ? iconMarkup(dtIc) : '+'; }
$('#dt_iconBtn').addEventListener('click', () => {
  ipTarget = v => { dtIc = v || ''; dtIconBtn(); };
  $('#e_icon_custom').value = dtIc && !ICONS[dtIc] ? dtIc : ''; $('#ip_q').value = ''; drawIconPicker('');
  $('#iconPick').showModal(); $('#ip_scroll').scrollTop = 0; ipSpy();
});
function openDayTypeDlg(id){
  dtEdit = id; const t = id ? dayTypes().find(x => x.id === id) : null;
  dtIc = (t && (store.get('typeIcons', {}) || {})[t.name]) || ''; dtIconBtn();
  $('#dt_title').textContent = t ? 'Edit day type' : 'New day type'; $('#dt_t').value = t ? t.name : ''; $('#dt_err').hidden = true; $('#dt_del').hidden = !t;
  $('#dtDlg').showModal(); $('#dt_t').focus(); setTimeout(() => $('#dt_t').focus(), 80);
}
function dayTypesChanged(){ syncTypes(); drawDayTypes(); drawUsual(); render(); }
function dtSave(){
  const v = $('#dt_t').value.trim().replace(/\s+/g, ' '), err = msg => { $('#dt_err').textContent = msg; $('#dt_err').hidden = false; };
  if (!v){ err('Give it a name.'); return; }
  if (Object.entries(MODE_LABEL).some(([k, n]) => k !== dtEdit && n.toLowerCase() === v.toLowerCase())){ err('There is already a day type called ' + v + '.'); return; }
  const cs = dayTypes(), t = dtEdit ? cs.find(x => x.id === dtEdit) : null;
  const TI = { ...(store.get('typeIcons', {}) || {}) }; if (t && t.name !== v) delete TI[t.name]; if (dtIc) TI[v] = dtIc; else delete TI[v]; store.set('typeIcons', TI);
  if (t) t.name = v; else cs.push({ id:'x' + Date.now().toString(36), name:v });
  store.set('dayTypes', cs); $('#dtDlg').close(); dayTypesChanged();
}
$('#dt_ok').onclick = dtSave;
$('#dt_x').onclick = () => $('#dtDlg').close();
$('#dt_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); dtSave(); } });
$('#dtAdd').onclick = () => openDayTypeDlg(null);
$('#dtList').addEventListener('click', e => { const b = e.target.closest('[data-dt]'); if (b) openDayTypeDlg(b.dataset.dt); const sb = e.target.closest('[data-slot]'); if (sb) openSlotDlg(sb.dataset.slot); });
let slotK = null, slotPick = null;
function openSlotDlg(k){
  slotK = k; slotPick = BUILTIN_TYPES[k]; const def = SLOT_DEF[k], taken = new Set(Object.entries(MODE_LABEL).filter(([id]) => id !== k).map(([, n]) => n.toLowerCase()));
  const opts = [def, 'Work', 'Sick'].filter(n => !taken.has(n.toLowerCase()));
  if (slotPick && !opts.some(n => n.toLowerCase() === slotPick.toLowerCase())) opts.push(slotPick);
  $('#sl_title').textContent = 'Swap ' + def;
  $('#sl_opts').style.setProperty('--n', opts.length);
  $('#sl_opts').innerHTML = opts.map(n => '<button type="button" data-n="' + n + '"' + (n === slotPick ? ' class="on"' : '') + '>' + dtIcon(n) + n + '</button>').join('');
  $('#slotDlg').showModal(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
$('#sl_opts').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; slotPick = b.dataset.n; [...$('#sl_opts').children].forEach(x => x.classList.toggle('on', x === b)); });
$('#sl_ok').onclick = () => { const o = { ...slotNames() }; if (slotPick === SLOT_DEF[slotK]) delete o[slotK]; else o[slotK] = slotPick; store.set('slotNames', o); $('#slotDlg').close(); dayTypesChanged(); };
$('#sl_x').onclick = () => $('#slotDlg').close();
$('#dt_del').onclick = async () => {
  const id = dtEdit, t = id && dayTypes().find(x => x.id === id); if (!t) return;
  if (!await ask('Delete the ' + t.name + ' day type? The tasks you added to it are deleted too, and days that used it become unset.', { ok:'Delete', danger:true })) return;
  { const TI = { ...(store.get('typeIcons', {}) || {}) }; delete TI[t.name]; store.set('typeIcons', TI); }
  const b = store.get('blocks', null); if (b && b[id]){ delete b[id]; store.set('blocks', b); }
  const pl = store.get('plans', {}); Object.values(pl).forEach(p => { if (p && p.t) Object.keys(p.t).forEach(k => { if (p.t[k] === id) delete p.t[k]; }); }); store.set('plans', pl); plans = pl;
  const us = store.get('usual', {}); Object.keys(us).forEach(k => { if (us[k] === id) delete us[k]; }); store.set('usual', us);
  if (day && day.types) Object.keys(day.types).forEach(k => { if (day.types[k] === id) delete day.types[k]; });
  store.set('dayTypes', dayTypes().filter(x => x.id !== id)); saveDay(); $('#dtDlg').close(); dayTypesChanged();
};

$('#dnote').parentElement.insertAdjacentHTML('beforebegin', '<div class="sleep" id="energyCard"></div>');
const EN_NAMES = ['Drained', 'Low', 'Okay', 'Good', 'Great'], EN_COL = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
function drawEnergy(){
  const el = $('#energyCard'); if (!el) return;
  if (viewDate !== todayStr() || snapMode()){ el.style.display = 'none'; return; }
  el.style.display = '';
  const T = store.get('energy', []).filter(x => x.d === todayStr()), last = T[T.length - 1];
  const btn = (n, i) => '<button data-en="' + (i + 1) + '" class="' + (last && last.v === i + 1 ? 'on' : '') + '" style="--ec:' + EN_COL[i] + ';--ecb:' + EN_COL[i] + '24" aria-pressed="' + !!(last && last.v === i + 1) + '" aria-label="' + (i + 1) + ', ' + n + '"><span class="enN">' + (i + 1) + '</span><span class="enL">' + n + '</span></button>';
  el.innerHTML = '<div class="cardHd"><span class="cardIc">' + ICONS.bolt + '</span><div><h2>How is your energy?</h2><p class="cardSub">Tap how you feel right now. A few ratings a day teach Yoteii your rhythm.</p></div></div><div class="enRow' + (last ? ' has' : '') + '">' + EN_NAMES.map(btn).join('') + '</div>' +
    (last ? '<p class="wn enNow"><i style="background:' + EN_COL[last.v - 1] + '"></i><span><b>' + EN_NAMES[last.v - 1] + '</b> at ' + fmt(last.at).join(' ') + '. Tap it again to clear, or tap another to change.</span></p>'
          : '');
}
$('#energyCard').addEventListener('click', e => {
  const b = e.target.closest('[data-en]'); if (!b) return;
  const L = store.get('energy', []), v = Number(b.dataset.en);
  let li = -1; for (let i = L.length - 1; i >= 0; i--) if (L[i].d === todayStr()){ li = i; break; }
  if (li >= 0 && L[li].v === v){ L.splice(li, 1); store.set('energy', L); toast('Energy cleared'); drawEnergy(); drawRhythm(); return; }     // tapped the chosen level again: clear it
  L.push({ v, at:nowM(), o:nowM() - wake, w:defaultWin(), d:todayStr() });
  store.set('energy', L.slice(-500)); toast('Energy ' + b.dataset.en + ' saved'); drawEnergy(); drawRhythm(); remSoon();
});

function taskInsight(id){
  const H = store.get('hist', {}), days = Object.keys(H).sort((a, b) => cmpDay(b, a));
  let tot = 0, dn = 0, streak = 0, live = true;
  days.forEach(d => {
    const r = (H[d].rows || []).find(x => x.id === id && x.u > 0 && !x.sug); if (!r) return;
    if (d === todayStr() && !r.done) return;
    tot++; if (r.done){ dn++; if (live) streak++; } else live = false;
  });
  if (tot < 3) return '';
  const pc = Math.round(dn / tot * 100);
  return 'Done ' + dn + ' of ' + tot + ' days (' + pc + '%)' + (streak > 1 ? ', ' + streak + ' in a row' : '') + '.' + (tot >= 5 && pc < 40 ? ' You skip this often. Try shortening it or moving it to another window.' : '');
}
$('#ts_noteb').onclick = () => {
  noteEditing = sheetCtx.id; $('#taskSheet').close(); render();
  setTimeout(() => { const t = document.querySelector('.noteEdit .ntxt'); if (t){ t.scrollIntoView({ block:'center' }); t.focus(); } }, 60);
};
$('#ts_timer').onclick = () => {
  const r = schedule().rows.find(x => sameId(x.id, sheetCtx.id)); $('#taskSheet').close();
  if (!r || !(r.use > 0)) return;
  run = { k:r.w, q:[r], i:0, left:r.use * 60, paused:false, last:Date.now(), beeped:false };
  runDraw(); $('#runDlg').showModal();
  clearInterval(runTimer); runTimer = setInterval(runTick, 250);
  try{ if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); }catch{}
};


function backupJson(){
  return JSON.stringify({ app:'yotei', v:3, data:backupData() });
}
async function shareBackup(){
  if (IS_NATIVE && await shareBackupNative('yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json', backupJson())) return;
  const f = new File([backupJson()], 'yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json', { type:'application/json' });
  if (navigator.canShare && navigator.canShare({ files:[f] })){
    try{ await navigator.share({ files:[f], title:'Yoteii backup' }); store.set('lastBackup', Date.now()); updateBackupInfo(); return; }
    catch(e){ if (e && e.name === 'AbortError') return; }
  }
  exportData();
}
$('#shareBk').addEventListener('click', shareBackup);

// ---- drag and drop (edit mode): drop on a task to reorder, on the top bar to move ----
let drag = null, dragCand = null;
const dragMove = e => { const g = $('#dragGhost'); g.style.left = (e.clientX - 20) + 'px'; g.style.top = (e.clientY - 46) + 'px'; };
function beginDrag(row, e){
  drag = { id:row.dataset.id, l:row.dataset.l };
  const base = parseDay(viewDate);
  $('#dropBar').innerHTML = '<button data-inbox="1">Inbox</button>' + [1, 2, 3, 4, 5, 6, 7].map(i => { const d = new Date(base); d.setDate(base.getDate() + i); return '<button data-day="' + isoLocal(d) + '">' + d.toLocaleDateString(undefined, { weekday:'short' }) + ' ' + d.getDate() + '</button>'; }).join('');
  $('#dropBar').classList.add('show');
  const g = $('#dragGhost'); g.textContent = row.querySelector('.ttl').textContent.replace(/\s+/g, ' ').trim(); g.style.display = 'block'; dragMove(e);
  if (navigator.vibrate) navigator.vibrate(8);
}
document.addEventListener('pointerdown', e => {   // the drag handle (shown while editing) starts a drag at once
  const h = e.target.closest && e.target.closest('.dragH'); if (!h) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault(); lpClear(); lpFired = true; beginDrag(h.closest('.tlrow'), e);
});
document.addEventListener('pointermove', e => {
  if (dragCand && !drag && Math.hypot(e.clientX - dragCand.x, e.clientY - dragCand.y) > 8){ beginDrag(dragCand.row, e); dragCand = null; }
  if (!drag) return;
  e.preventDefault(); dragMove(e);
  if (e.clientY < 120) window.scrollBy(0, -12); else if (e.clientY > innerHeight - 140) window.scrollBy(0, 12);
  document.querySelectorAll('#dropBar .over, .dropRow').forEach(x => x.classList.remove('over', 'dropRow'));
  const el = document.elementFromPoint(e.clientX, e.clientY); if (!el) return;
  const chip = el.closest('#dropBar button'), row = el.closest('.tlrow');
  if (chip) chip.classList.add('over'); else if (row && row.dataset.id !== drag.id) row.classList.add('dropRow');
}, { passive:false });
$('#tl').addEventListener('touchmove', e => { if (drag || dragCand) e.preventDefault(); }, { passive:false });
$('#tl').addEventListener('contextmenu', e => { if (e.target.closest('.tlrow')) e.preventDefault(); });
function dragEnd(e, cancel){
  if (dragCand){ const c = dragCand; dragCand = null; if (!cancel && !drag){ openEd(c.row.dataset.l, c.row.dataset.id); return; } }
  if (!drag) return;
  const d = drag; drag = null;
  const el = cancel ? null : document.elementFromPoint(e.clientX, e.clientY);
  const chip = el && el.closest('#dropBar button'), tgt = el && el.closest('.tlrow');
  $('#dropBar').classList.remove('show'); $('#dragGhost').style.display = 'none';
  document.querySelectorAll('#dropBar .over, .dropRow').forEach(x => x.classList.remove('over', 'dropRow'));
  if (!el) return;
  if (chip){
    sheetCtx = { l:d.l, id:d.id };
    if (chip.dataset.inbox) mvDo('inbox');
    else { if (chip.dataset.day === viewDate) return; $('#mv_d').value = chip.dataset.day; $('#mv_t').value = ''; mvDo('move'); }
  } else if (tgt && tgt.dataset.id !== d.id){ const rb = tgt.getBoundingClientRect(); reorderBlock(d.l, d.id, tgt.dataset.id, tgt.dataset.l, e.clientY > rb.top + rb.height / 2); }
}
document.addEventListener('pointerup', e => dragEnd(e, false));
document.addEventListener('pointercancel', e => dragEnd(e, true));
function reorderBlock(l, id, beforeId, tl, after){
  if (l !== tl){ toast('Drop it on a task in the same list.'); return; }
  const _s = grab(), arr = clone(getBlocks(l)), i = arr.findIndex(x => sameId(x.id, id)), j = arr.findIndex(x => sameId(x.id, beforeId)), wk = x => x.w || 'climb1';
  if (i < 0 || j < 0 || wk(arr[i]) !== wk(arr[j])){ toast('Drop it on a task in the same window.'); return; }
  if (arr[i].fixed !== undefined || arr[i].at !== undefined){ toast('This task is ordered by its Start time. Change it in Edit to move it.'); return; }
  const was = arr.map(z => z.id).join();
  const [x] = arr.splice(i, 1), k = arr.findIndex(z => sameId(z.id, beforeId)); arr.splice(after ? k + 1 : k, 0, x);      // dropped on the lower half: it goes after that task
  if (arr.map(z => z.id).join() === was) return;
  needLive();
  setBlocks(l, arr); render(); showUndo(l === 'oo' ? 'Reordered' : 'Reordered for all days', _s);
}

// ============================================================
// EDITABLE PAST DAYS + COLOR PICKER
// ============================================================
function needLive(){
  if (!snapMode()) return false;
  day.live = true; saveDay();
  toast('Rebuilt this day from your current routines so it can be edited.');
  return true;
}
const RING = ['#f87171', '#fb923c', '#fbbf24', '#facc15', '#a3e635', '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#f472b6', '#fb7185', '#94a3b8', '#f8fafc'];
const RECENT0 = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
const hex2 = n => Math.round(n).toString(16).padStart(2, '0');
function hsv2hex(h, s, v){
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + hex2(f(5) * 255) + hex2(f(3) * 255) + hex2(f(1) * 255);
}
function hex2hsv(hx){
  const m = /^#?([0-9a-f]{6})$/i.exec(hx || ''); if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0; if (d){ h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s:mx ? d / mx : 0, v:mx };
}
let CT = 'e';
function drawColorRow(p){
  p = typeof p === 'string' ? p : CT;
  const v = ($('#' + p + '_color').value || '').toLowerCase(), inList = RING.includes(v), custom = v && !inList;
  $('#' + p + '_colors').innerHTML = '<button type="button" class="cring cauto' + (!v ? ' on' : '') + '" data-c="" role="radio" aria-checked="' + !v + '" aria-label="Automatic colour">Auto</button>' +
    RING.map(c => '<button type="button" class="cring' + (v === c ? ' on' : '') + '" data-c="' + c + '" style="--c:' + c + ';--ck:' + onColor(c) + '" role="radio" aria-checked="' + (v === c) + '" aria-label="Color ' + c + '"></button>').join('') +
    '<button type="button" class="cring ccustom' + (custom ? ' has on' : '') + '" data-custom="1" style="--c:' + (custom ? v : 'transparent') + '" role="radio" aria-checked="' + !!custom + '" aria-label="Pick a custom color"></button>';
}
function setEdAccent(){
  const c = $('#e_color').value || (WIN_STYLE[cur.wk] || WIN_STYLE.climb1).c, ed = $('#ed');
  ed.style.setProperty('--accent', c); ed.style.setProperty('--onacc', onColor(c));
}
['e', 'tdl', 'tg', 'tde'].forEach(p => $('#' + p + '_colors').addEventListener('click', e => {
  e.preventDefault();   // stop the wrapping label from re-clicking the first swatch
  const b = e.target.closest('button'); if (!b) return;
  CT = p;
  if (b.dataset.custom){ openColorSheet(); return; }
  $('#' + p + '_color').value = b.dataset.c; drawColorRow(p); if (p === 'e') setEdAccent();
}));

let hsv = { h:45, s:.8, v:1 }, wheelDrawn = false, csDrag = null;
function drawWheel(){
  const c = $('#cs_canvas'), x = c.getContext('2d'), n = c.width, R = n / 2, img = x.createImageData(n, n), d = img.data;
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++){
    const dx = px - R + .5, dy = py - R + .5, r = Math.hypot(dx, dy); if (r > R) continue;
    const h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, s = r / R, i = (py * n + px) * 4;
    const f = k => { const q = (k + h / 60) % 6; return 1 - s * Math.max(0, Math.min(q, 4 - q, 1)); };
    d[i] = f(5) * 255; d[i + 1] = f(3) * 255; d[i + 2] = f(1) * 255; d[i + 3] = r > R - 1 ? (R - r) * 255 : 255;
  }
  x.putImageData(img, 0, 0);
}
function csApply(){
  const hx = hsv2hex(hsv.h, hsv.s, hsv.v), R = $('#cs_wheel').clientWidth / 2, a = hsv.h * Math.PI / 180, kn = $('#cs_knob');
  kn.style.left = (R + Math.cos(a) * hsv.s * R) + 'px'; kn.style.top = (R - Math.sin(a) * hsv.s * R) + 'px'; kn.style.background = hx;
  $('#cs_bright').style.background = 'linear-gradient(to right,#000,' + hsv2hex(hsv.h, hsv.s, 1) + ')';
  $('#cs_bthumb').style.left = (hsv.v * $('#cs_bright').clientWidth) + 'px';
  $('#cs_prev').style.background = hx;
  $('#' + CT + '_color').value = hx; drawColorRow(CT); if (CT === 'e') setEdAccent();
}
function drawRecent(){
  $('#cs_recent').innerHTML = store.get('recentColors', RECENT0).slice(0, 5).map(c => '<button type="button" data-c="' + c + '" style="background:' + c + '" aria-label="Use ' + c + '"></button>').join('');
}
function openColorSheet(){
  if (!wheelDrawn){ drawWheel(); wheelDrawn = true; }
  hsv = hex2hsv($('#' + CT + '_color').value) || hex2hsv('#ffc533');
  drawRecent(); $('#colorSheet').showModal(); csApply();
}
function csClose(){
  const v = ($('#' + CT + '_color').value || '').toLowerCase();
  if (v && !RING.includes(v)){ const L = store.get('recentColors', RECENT0).filter(c => c.toLowerCase() !== v); L.unshift(v); store.set('recentColors', L.slice(0, 5)); }
  if ($('#colorSheet').open) $('#colorSheet').close();
}
const csWheelPt = e => { const r = $('#cs_wheel').getBoundingClientRect(), R = r.width / 2, dx = e.clientX - r.left - R, dy = e.clientY - r.top - R; hsv.h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360; hsv.s = Math.min(Math.hypot(dx, dy) / R, 1); csApply(); };
const csBrightPt = e => { const r = $('#cs_bright').getBoundingClientRect(); hsv.v = Math.max(.12, Math.min(1, (e.clientX - r.left) / r.width)); csApply(); };
[['cs_wheel', 'w', csWheelPt], ['cs_bright', 'b', csBrightPt]].forEach(([id, k, fn]) => {
  const el = $('#' + id);
  el.addEventListener('pointerdown', e => { csDrag = k; el.setPointerCapture(e.pointerId); fn(e); });
  el.addEventListener('pointermove', e => { if (csDrag === k) fn(e); });
  ['pointerup', 'pointercancel'].forEach(ev => el.addEventListener(ev, () => { csDrag = null; }));
});
$('#cs_recent').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; hsv = hex2hsv(b.dataset.c); csApply(); });
$('#cs_done').onclick = csClose;
$('#colorSheet').addEventListener('click', e => { if (e.target === $('#colorSheet')) csClose(); });
(function(){ let y0 = null; const h = $('#cs_handle');
  h.addEventListener('pointerdown', e => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (y0 !== null && e.clientY - y0 > 60){ y0 = null; csClose(); } });
  ['pointerup', 'pointercancel'].forEach(ev => h.addEventListener(ev, () => { y0 = null; }));
})();

// ============================================================
// DELETE HISTORY, WINDOW COLORS
// ============================================================
const WIN_DEF = Object.fromEntries(Object.entries(WIN_STYLE).map(([k, v]) => [k, v.c]));
const WIN_ICON_DEF = Object.fromEntries(Object.entries(WIN_STYLE).map(([k, v]) => [k, v.i]));
function applyWinColors(){ const W = wins(); for (const k in WIN_STYLE){ WIN_STYLE[k].c = safeCol(W[k].color) || WIN_DEF[k]; WIN_STYLE[k].i = W[k].icon || WIN_ICON_DEF[k]; } }
function applyWinScope(sc, c){
  const iso = viewDate, filt = {};
  if (scDays.length) filt.days = scDays.slice().sort();
  const o = store.get('wins', {}), W = store.get('wovr', {}), k = c.id, hasFilt = !!filt.days, base = winBase(k);
  const patch = c.type === 'reset' ? { name:base.name, note:base.note, from:base.from, to:base.to, color:null, icon:null } : diffBlock(c.old, c.b);
  if (Object.keys(patch).length){
    if (sc === 'all' && !hasFilt){
      if (c.type === 'reset'){ delete o[k]; delete W[k]; }
      else {
        o[k] = { ...(o[k] || {}) };
        Object.keys(patch).forEach(f => { if (patch[f] === null) delete o[k][f]; else o[k][f] = patch[f]; });
        if (!Object.keys(o[k]).length) delete o[k];
        (W[k] || []).forEach(e => Object.keys(patch).forEach(f => { delete e.patch[f]; }));
        W[k] = (W[k] || []).filter(e => Object.keys(e.patch).length); if (!W[k].length) delete W[k];
      }
    } else (W[k] = W[k] || []).push({ from:sc === 'all' ? null : iso, to:sc === 'day' ? iso : null, ...filt, patch });
  }
  store.set('wins', o); store.set('wovr', W); scopeCtx = null; $('#scopeDlg').close(); $('#ed').close(); render();
}
applyWinColors();
function delHist(ds){
  const _s = grab(), H = store.get('hist', {}); delete H[ds]; store.set('hist', H);
  delete plans[ds]; store.set('plans', plans);
  const tn = store.get('taskNotes', {}); Object.keys(tn).forEach(k => { if (k.split('_')[0] === ds) delete tn[k]; }); store.set('taskNotes', tn);
  if (viewDate === ds) loadDay(ds);
  lastSig = ''; render(); showUndo('Record deleted', _s);
}
async function clearHist(){
  if (!await ask('Delete the saved records of all past days, including their done marks, task notes and finished to-dos? Your routines are kept.', { ok:'Delete', danger:true })) return;
  const _s = grab(), t = todayStr();
  store.set('hist', {});
  store.set('todoLog', store.get('todoLog', []).filter(x => x.d >= t));      // finished to-dos from past days go too
  Object.keys(plans).forEach(d => { if (d < t) delete plans[d]; }); store.set('plans', plans);
  const tn = store.get('taskNotes', {}); Object.keys(tn).forEach(k => { if (k.split('_')[0] < t) delete tn[k]; }); store.set('taskNotes', tn);
  lastSig = ''; loadDay(viewDate); render(); showUndo('History deleted', _s);
}
$('#histbox').addEventListener('click', async e => {
  const b = e.target.closest('.hdel'); if (!b) return;
  if (await ask('Delete the saved record for ' + parseDay(b.dataset.hd).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' }) + '? This removes its done marks and task notes.', { ok:'Delete', danger:true })) delHist(b.dataset.hd);
});
$('#tab-settings').insertAdjacentHTML('beforeend', '<div class="sleep"><h2>History data</h2><p class="wn">Delete the saved records of past days, with their done marks and task notes. Your routines stay as they are. You can also delete a single day from the History tab.</p><button class="add" id="clrHist">Delete all recorded history</button></div>');
$('#clrHist').addEventListener('click', clearHist);

// ============================================================
// STRUCTURED-STYLE SHELL: header, week dots, add button
// ============================================================
function drawHdr(){
  const t = document.body.dataset.tab || 'home', d = parseDay(viewDate), el = $('#hdrTitle'); if (!el) return;
  if (t === 'home') el.innerHTML = esc(d.toLocaleDateString(undefined, { month:'long' })) + ' <em>' + d.getFullYear() + '</em>';
  else el.textContent = ({ inbox:'Inbox', todo:'To-do', history:'History', settings:'Settings' })[t] || 'Yoteii';
  if (t === 'home'){ el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-haspopup', 'dialog'); }
  else { el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-haspopup'); }
}
function dayMeta(ds){      // what the strip and calendar show beside a day: away, note, rated, past
  const td = todayStr(), cur = ds === viewDate, p = cur ? null : planFor(ds), h = (store.get('hist', {}) || {})[ds];
  return {
    away: cur ? !!day.away : !!(p && p.a),
    note: cur ? !!String(day.note || '').trim() : !!(String((p && p.n) || '').trim() || (h && h.note)),
    rated: store.get('energy', []).some(x => x.d === ds),
    past: ds < td, snap: !!h && ds < td
  };
}
function dayColors(ds){
  let rows = [];
  if (ds === viewDate) rows = schedule().rows;
  else { const sv = { wake, day, done }; try{ loadDay(ds); rows = build(dowOf(ds)).rows; }catch{} finally{ wake = sv.wake; day = sv.day; done = sv.done; } }
  const out = [], seen = new Set();
  rows.forEach(r => {
    if (!(r.use > 0) || r.sug || out.length >= 3) return;
    const c = safeCol(r.color) || (WIN_STYLE[r.w] || WIN_STYLE.climb1).c, k = String(c).toLowerCase();
    if (!seen.has(k)){ seen.add(k); out.push({ c, i:r.icon || guessIcon(r.t) || (WIN_STYLE[r.w] || WIN_STYLE.climb1).i }); }
  });
  return out;
}
const FAB_HINT = { add:'Put it on your timeline', inbox:'Quick thought, sort it later', todo:'Something for your list', late:'Push the rest of your day back', copy:'Reuse this plan on another date' };
$('#fab').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
$('#fab').addEventListener('click', () => {
  const inbox = '<svg viewBox="0 0 24 24"><path d="M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5"/></svg>';
  $('#fabMenu .fabIn').innerHTML = [['add', ICONS.pen, 'Add a task'], ['inbox', inbox, 'Add to inbox'], ['todo', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>', 'Add a to-do'], ['late', ICONS.alarm, day.shift ? 'Pushed ' + day.shift.by + ' min later' : 'Running late?'], ['copy', ICONS.calendar, 'Copy this day']]
    .map(a => '<button data-a="' + a[0] + '"><span class="fbIc">' + a[1] + '</span><span class="fbT">' + a[2] + '</span><small>' + FAB_HINT[a[0]] + '</small><svg class="fbCh" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>').join('');
  $('#fabMenu').showModal();
});
$('#fabMenu').addEventListener('click', e => {
  if (e.target === $('#fabMenu') || e.target.closest('#fabX')){ $('#fabMenu').close(); return; }
  const b = e.target.closest('.fabIn button'); if (!b) return;
  $('#fabMenu').close();
  if (b.dataset.a === 'add'){ openEd('oo', null, defaultWin()); cur.addScope = true; drawEdTypes(); }
  else if (b.dataset.a === 'inbox') openInboxComposer();
  else if (b.dataset.a === 'todo'){ setTab('todo'); openTodoEd(null); }
  else if (b.dataset.a === 'late') openShift();
  else openMv('day');
});

$('#clrAll').addEventListener('click', () => { $('#clr_ok').checked = false; $('#clr_go').disabled = true; $('#clrDlg').showModal(); });
$('#clr_ok').addEventListener('change', e => { $('#clr_go').disabled = !e.target.checked; });
$('#clr_x').onclick = () => $('#clrDlg').close();
$('#clr_exp').onclick = () => shareBackup();
$('#clr_go').onclick = async () => {
  try{ await clearAll(); }catch{}
  try{ sessionStorage.clear(); }catch{}
  location.replace(location.pathname);
};

// ============================================================
// SAFETY, ACCESSIBILITY, EMPTY STATE
// ============================================================
function safeCol(c){ return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : null; }
Object.entries({ ed:'Task editor', fabMenu:'Add', iconPick:'Choose an icon', colorSheet:'Pick a colour', scopeDlg:'Apply this change to', snapDlg:'Snapshots', mvDlg:'Move or copy', shDlg:'Running late', clrDlg:'Clear all data', setupDlg:'Welcome to Yoteii', welDlg:'Welcome to Yoteii', qaDlg:'Quick add', tdlDlg:'To-do list', tgDlg:'Tag', dtDlg:'Day type', tdeDlg:'To-do', runDlg:'Routine timer', taskSheet:'Task details', blockInfo:'Block information', stepsSheet:'Subtasks', msgDlg:'Message' })
  .forEach(([id, l]) => { const d = document.getElementById(id); if (d) d.setAttribute('aria-label', l); });
$('#tl').insertAdjacentHTML('beforebegin', '<div class="sleep emptyCard" id="emptyCard" hidden><h2>Start with your first task</h2><p class="wn">Add what you want to do today. A task added for all days repeats every day. You can use the + button any time.</p><button class="add" id="emptyAdd">Add a task</button></div>');
function drawEmpty(){
  const el = $('#emptyCard'); if (!el) return;
  el.hidden = schedule().rows.some(r => r.use > 0 && !r.sug);
}
$('#emptyAdd').addEventListener('click', () => { openEd('oo', null, defaultWin()); cur.addScope = true; drawEdTypes(); });
$('#hdrTitle').addEventListener('click', () => { if (document.body.dataset.tab === 'home' && viewDate !== todayStr()) goDate(todayStr()); });
function focusNow(){ if (viewDate !== todayStr()) return; const r = document.querySelector('.tlrow.now'); if (r) r.scrollIntoView({ block:'center' }); }

(function(){
  const list = a => a.map(x => '<li>' + esc(x) + '</li>').join('');
  const sect = (n, a) => a && a.length ? '<h3>' + n + '</h3><ul>' + list(a) + '</ul>' : '';
  $('#tab-settings').insertAdjacentHTML('beforeend',
    '<div class="sleep about"><h2 class="srOnly">About Yoteii</h2><div class="aboutHero"><div class="aboutLogo" aria-hidden="true"><span>予定</span></div><b>Yoteii</b><small>v' + APP_VERSION + '</small></div><p class="aboutStat"><i></i><span><b>Status: stable</b><small>Everything below is working.</small></span></p><button class="add" id="replayWel" type="button">Show the welcome tour</button><details class="srcDet"><summary>Features</summary><ul>' + list(FEATURES) + '</ul></details><details class="srcDet"><summary>Good to know</summary><ul>' + list(LIMITS) + '</ul></details><p class="wn">Icons: Phosphor, and Font Awesome Free (CC BY 4.0, fontawesome.com).</p><p class="wn">Yoteii was inspired by <b>Structured</b>. Much of its look and layout (the timeline, week strip, Inbox and add button) comes from that app, with thanks.</p></ul></div>' +
    '<div class="sleep about"><h2>Changelog</h2>' + (() => {
      const MON = { Jan:'January', Feb:'February', Mar:'March', Apr:'April', May:'May', Jun:'June', Jul:'July', Aug:'August', Sep:'September', Oct:'October', Nov:'November', Dec:'December' };
      const label = d => { const z = /^([A-Za-z]{3})[a-z]* (\d{4})$/.exec(d || ''); return z && MON[z[1]] ? MON[z[1]] + ' ' + z[2] : (d === 'Initial' ? 'First release' : d || 'Earlier'); };
      const groups = [];
      CHANGELOG.forEach(c => { const l = label(c.date), g = groups[groups.length - 1]; if (g && g.l === l) g.items.push(c); else groups.push({ l, items:[c] }); });
      return groups.map((g, gi) => '<details class="clMonth"' + (gi === 0 ? ' open' : '') + '><summary>' + esc(g.l) + '<span>' + g.items.length + (g.items.length === 1 ? ' version' : ' versions') + '</span></summary>' +
        g.items.map((c, i) => '<details class="clog"' + (gi === 0 && i === 0 ? ' open' : '') + '><summary>v' + esc(c.v) + '</summary>' + sect('Added', c.added) + sect('Changed', c.changed) + sect('Fixed', c.fixed) + '</details>').join('') + '</details>').join('');
    })() + '</div>');
})();
const tabs = document.querySelectorAll('.tabs button');
// ---- Android back button (only wired up inside the Android app) ----
const BACK_ORDER = ['msgDlg', 'suOwnDlg', 'dtDlg', 'tgDlg', 'iconPick', 'colorSheet', 'tdlDlg', 'tdeDlg', 'qaDlg', 'welDlg', 'scopeDlg', 'mvDlg', 'snapDlg', 'shDlg', 'clrDlg', 'stepsSheet', 'runDlg', 'blockInfo', 'taskSheet', 'edSub', 'ed', 'fabMenu'];
function handleBack(){
  for (const id of BACK_ORDER){
    const d = document.getElementById(id);
    if (!d || !d.open) continue;
    const x = id === 'fabMenu' ? null : d.querySelector('#dt_x,#tg_x,#tdl_x,#tde_x,#qa_x,#wl_skip,#sc_x,#ip_x,#mv_x,#snap_x,#sh_x,#clr_x,#runClose,#ss_close,#e_x');
    if (x) x.click(); else d.close();
    return true;
  }
  if (document.body.dataset.tab === 'settings' && document.body.dataset.setpage){ setPageOpen(null); return true; }   // inside a settings page: back to the menu
  if (document.body.dataset.tab !== 'home'){ setTab('home'); return true; }
  return false;
}
{ const app = nativePlugin('App'); if (app) app.addListener('backButton', () => { if (!handleBack()) app.exitApp(); }); }
function setTab(t){
  if (toastUntil && Date.now() - toastShownAt > 500) hideToast();   // a message from the previous screen shouldn't follow you around
  tabs.forEach(b => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); b.setAttribute('aria-controls', 'tab-' + b.dataset.tab); });
  document.querySelectorAll('.tab').forEach(sec => { sec.hidden = sec.id !== 'tab-' + t; sec.setAttribute('role', 'tabpanel'); });
  store.set('tab', t); document.body.dataset.tab = t; drawHdr();
  if (t === 'settings') setPageOpen(null);      // tapping Settings always shows the menu
  if (t === 'todo') drawTodo();                 // due labels follow the clock
  if (t === 'history') drawHistory();            // always fresh: other tabs (To-do ticks, energy check-ins) change what it shows
}
tabs.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
setTab('home');          // always start on the Timeline
const FRESH = ['hist', 'plans', 'blocks', 'day', 'wake', 'setup'].every(k => store.get(k, null) === null);
migrateFields();
migrateV2();
migrateV3();
// Older versions could leave tasks with no id, a number for an id, or two tasks in a list with the same id.
{ const b = store.get('blocks', null); if (b){ const r = normalizeIds(b); if (r.changed) store.set('blocks', r.blocks); } }
render();
// a dialog opens above everything, so the Welcome dialog waits until the loading screen has gone
if (FRESH){ if (document.getElementById('boot')) window.__afterBoot = () => openSetup(); else openSetup(); }
setTimeout(focusNow, 150);
(function(){
  const a = new URLSearchParams(location.search).get('action'); if (!a) return;
  try{ history.replaceState(null, '', location.pathname); }catch{}
  setTab('home'); goDate(todayStr());
  if (a === 'morning') runStart('sleep'); else if (a === 'inbox') openInboxComposer();
})();
function migrateV2(){
  if (store.get('schemaV', 0) >= 2) return;
  const bl = store.get('blocks', null);
  if (bl){
    const moved = [];
    for (const l of ['home', 'school', 'away']){
      if (!Array.isArray(bl[l])) continue;
      bl[l] = bl[l].filter(b => { if (b && b.w === 'wind'){ if (l === 'home' && !b.sug) moved.push(b); return false; } return true; });
    }
    if (!bl.night && moved.length) bl.night = moved.map(b => { const c = { ...b }; delete c.w; if (!c.p){ c.p = 'flex'; c.m = Math.min(c.d, 5); } return c; });
    store.set('blocks', bl);
  }
  store.set('schemaV', 2);
}
function migrateV3(){  // add the new Away suggestions to an Away list you already customised
  if (store.get('schemaV', 0) >= 3) return;
  const bl = store.get('blocks', null);
  if (bl && Array.isArray(bl.away)){
    const add = MODES.away.post.filter(d => /^a[cm]\d/.test(d.id) && !bl.away.some(x => x.id === d.id));
    if (add.length){ bl.away = bl.away.concat(add); store.set('blocks', bl); }
  }
  store.set('schemaV', 3);
}
function updateBackupInfo(){
  const t = store.get('lastBackup', 0), d = t ? Math.floor((Date.now() - t) / 864e5) : null;
  const needs = (d === null || d >= 7) && Object.keys(store.get('hist', {})).length >= 3;
  const bytes = estimateBytes();
  $('#bkInfo').textContent = (d === null ? 'No backup yet.' : d === 0 ? 'Last backup: today.' : 'Last backup: ' + d + ' day' + (d === 1 ? '' : 's') + ' ago.') + ' Stored on this device: ' + Math.max(1, Math.round(bytes / 1024)) + ' KB.';
  $('#settingsBtn').classList.toggle('nudge', needs); document.querySelector('.tabs [data-tab=settings]').classList.toggle('nudge', needs);
  $('#settingsBtn').setAttribute('aria-label', needs ? 'Settings, backup suggested' : 'Settings');
}
if (IS_NATIVE) $('#bkWhy').textContent = 'Your tasks, blocks and history live on this device only. Export a copy so uninstalling the app or clearing its data does not erase them.';
updateBackupInfo();
if ($('#settingsBtn').classList.contains('nudge') && store.get('bkAsk', '') !== todayStr()){ store.set('bkAsk', todayStr()); setTimeout(() => toast('Time for a backup. Your data lives only on this device.', 'Back up', shareBackup), 1500); }
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && !IS_NATIVE){
  // The page may already have finished loading by the time this script runs (startup waits for saved data).
  const registerSw = () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); };
  if (document.readyState === 'complete') registerSw(); else window.addEventListener('load', registerSw);
}
// ---- Settings > Schedule > Tasks with dates: a task past its end date leaves the timeline, so this is where it can still be found ----
const listLabel = l => (TPL[l] && TPL[l].label) || (MODE_LABEL[l] ? MODE_LABEL[l] + ' day' : l);
function dateText(ds){ const d = parseDay(ds), y = d.getFullYear() !== new Date().getFullYear(); return d.toLocaleDateString(undefined, y ? { month:'short', day:'numeric', year:'numeric' } : { month:'short', day:'numeric' }); }
function datedTasks(){
  const out = [];
  TASK_LISTS.forEach(l => getBlocks(l).forEach(b => { if (b.from || b.to) out.push({ l, b }); }));
  return out;
}
function drawDated(){
  const el = $('#datedList'); if (!el) return;
  const t = todayStr(), list = datedTasks();
  el.innerHTML = list.length ? list.map(({ l, b }) => {
    const range = b.from && b.to ? dateText(b.from) + ' to ' + dateText(b.to) : b.from ? 'From ' + dateText(b.from) : 'Until ' + dateText(b.to);
    const st = b.to && b.to < t ? 'Ended' : b.from && b.from > t ? 'Not started' : 'Active';
    return '<div class="dtRow"><div class="dtTxt"><b>' + esc(b.t || 'Task') + '</b><small>' + esc(listLabel(l)) + ' &middot; ' + range + ' &middot; ' + st + '</small></div><div class="dtAct"><button data-dedit="' + esc(String(b.id)) + '" data-dl="' + l + '">Edit</button><button data-drm="' + esc(String(b.id)) + '" data-dl="' + l + '" aria-label="Remove ' + esc(b.t || 'task') + '">&times;</button></div></div>';
  }).join('') : '<p class="wn">No tasks with dates yet. When you add or change a task, choose "Or choose dates" to give it a start and an end.</p>';
}
$('#datedList').addEventListener('click', async e => {
  const ed = e.target.closest('[data-dedit]'), rm = e.target.closest('[data-drm]');
  if (ed){ openEd(ed.dataset.dl, ed.dataset.dedit); return; }
  if (rm){
    if (!await ask('Remove this task from every day?', { ok:'Remove', danger:true })) return;
    const l = rm.dataset.dl, id = rm.dataset.drm, lk = (getBlocks(l).find(x => sameId(x.id, id)) || {}).lk;
    setBlocks(l, clone(getBlocks(l)).filter(x => !sameId(x.id, id)));
    if (lk) TASK_LISTS.forEach(L => { if (L !== l) setBlocks(L, clone(getBlocks(L)).filter(x => x.lk !== lk)); });
    render(); drawDated(); toast('Task removed');
  }
});
// ============================================================
// SETTINGS MENU: grouped rows that each open their own page. The cards themselves are moved, not rebuilt, so every control keeps working.
// ============================================================
const SI = {
  bell:'<path d="M6 17h12l-1.5-2v-4a4.5 4.5 0 0 0-9 0v4L6 17zM10 20a2 2 0 0 0 4 0"/>',
  palette:'<path d="M12 4a8 8 0 1 0 0 16c1.2 0 1.8-.8 1.5-1.8-.3-1 .3-2.2 1.5-2.2h1.5a3 3 0 0 0 3-3A8 8 0 0 0 12 4z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16" cy="11" r="1"/>',
  sliders:'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  pencil:'<path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3"/>',
  save:'<path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14"/>',
  cal:'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  reset:'<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>',
  flask:'<path d="M9 4h6M10 4v6l-5 9a1 1 0 0 0 1 1.5h12a1 1 0 0 0 1-1.5l-5-9V4"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  chev:'<path d="M9 6l6 6-6 6"/>', back:'<path d="M15 6l-6 6 6 6"/>'
};
const sIcon = (k, extra = '') => '<svg viewBox="0 0 24 24" aria-hidden="true"' + extra + '>' + SI[k] + '</svg>';
const SET_MENU = [
  { label:'General', rows:[
    { id:'prof',  t:'Profile',    ic:'user',    col:'#8478d0', cards:['Profile'] },
    { id:'rem',   t:'Reminders',  ic:'bell',    col:'#5fae6b', cards:['Reminders'] },
    { id:'look',  t:'Appearance', ic:'palette', col:'#8fb85a', cards:['Appearance'] },
    { id:'sched', t:'Schedule',   ic:'sliders', col:'#5b8bb8', cards:['Sleep caps', 'Leave time', 'Energy rhythm', 'Usual days', 'Day types', 'Routine templates', 'Tasks with dates'] },
    { id:'edit',  t:'Editing',    ic:'pencil',  col:'#e0a03a', cards:['Editing'] }] },
  { label:'Data', rows:[
    { id:'bk',    t:'Backup',          ic:'save',  col:'#e0787f', cards:['Backup'] },
    { id:'cal',   t:'Calendar import', ic:'cal',   col:'#5fae6b', cards:['Calendar import'] },
    { id:'hist',  t:'History data',    ic:'clock', col:'#5b8bb8', cards:['History data'] },
    { id:'reset', t:'Reset',           ic:'reset', col:'#d9606a', cards:['Reset'] }] },
  { label:'About', rows:[
    { id:'sci',   t:'Science sources', ic:'flask', col:'#8478d0', cards:['Science sources'] },
    { id:'about', t:'About Yoteii',     ic:'info',  col:'#5b8bb8', cards:['About Yoteii', 'Changelog'] }] }
];
function settingsValue(id){
  if (id === 'rem'){ const R = store.get('rem', { on:false }); return R.on && (IS_NATIVE ? remNative.perm === 'granted' : ('Notification' in window && Notification.permission === 'granted')) ? 'On' : 'Off'; }
  if (id === 'look'){ const s = $('#thSel'); return s ? s.selectedOptions[0].textContent : ''; }
  if (id === 'edit') return editing ? 'On' : 'Off';
  if (id === 'bk'){ const t = store.get('lastBackup', 0); return t ? (Date.now() - t < 864e5 ? 'Today' : new Date(t).toLocaleDateString(undefined, { month:'short', day:'numeric' })) : 'Never'; }
  if (id === 'prof'){ const P = store.get('profile', {}) || {}; return P.name || ''; }
  if (id === 'about') return 'v' + APP_VERSION;
  return '';
}
function updateSettingsValues(){ document.querySelectorAll('#setMenu .setRow').forEach(r => { r.querySelector('.setV').textContent = settingsValue(r.dataset.page); }); }
function setPageOpen(id){
  const menu = $('#setMenu'); if (!menu) return;
  document.querySelectorAll('#tab-settings .setPage').forEach(p => { p.hidden = p.dataset.page !== id; });
  menu.hidden = !!id; document.body.dataset.setpage = id || '';
  updateSettingsValues(); if (id === 'sched') drawDated(); window.scrollTo(0, 0);
}
function buildSettings(){
  const tab = $('#tab-settings'), all = [...tab.children].filter(c => c.classList.contains('sleep'));
  const find = name => all.find(c => { const h = c.querySelector('h2'); return h && h.textContent.trim().startsWith(name); });
  const menu = document.createElement('div'); menu.id = 'setMenu';
  const pages = [];
  SET_MENU.forEach(g => {
    menu.insertAdjacentHTML('beforeend', '<p class="setLbl">' + g.label + '</p>');
    const box = document.createElement('div'); box.className = 'setGroup';
    g.rows.forEach(r => {
      box.insertAdjacentHTML('beforeend', '<button type="button" class="setRow" data-page="' + r.id + '"><span class="setIc" style="background:' + r.col + '">' + (r.ic === 'user' ? ICONS.user : sIcon(r.ic)) + '</span><span class="setT">' + r.t + '</span><span class="setV"></span>' + sIcon('chev', ' class="setChev"') + '</button>');
      const cards = r.cards.map(find).filter(Boolean);
      const pg = document.createElement('div'); pg.className = 'setPage'; pg.dataset.page = r.id; pg.dataset.n = cards.length; pg.hidden = true;
      pg.insertAdjacentHTML('beforeend', '<div class="setHead"><button type="button" class="setBack" aria-label="Back to Settings">' + sIcon('back') + '</button><h2>' + r.t + '</h2></div>');
      cards.forEach(c => pg.appendChild(c)); pages.push(pg);
    });
    menu.appendChild(box);
  });
  tab.appendChild(menu); menu.insertAdjacentHTML('beforeend', '<p class="setCredit">Inspired by Structured</p>'); pages.forEach(p => tab.appendChild(p));
  all.filter(c => c.parentElement === tab).forEach(c => { c.hidden = true; });   // anything not placed above stays out of the way
  tab.addEventListener('click', e => {
    const r = e.target.closest('.setRow'); if (r){ setPageOpen(r.dataset.page); return; }
    if (e.target.closest('.setBack')){ setPageOpen(null); return; }
    setTimeout(updateSettingsValues, 80);
  });
  tab.addEventListener('change', () => setTimeout(updateSettingsValues, 80));
  setPageOpen(null);
}
buildSettings();

// Loading screen: leave once everything is drawn. In the Android app it stays for at least 6 seconds so the dots are seen.
window.__bootMin = IS_NATIVE ? 6000 : 0; if (window.__bootOff) window.__bootOff();
window.__bootReady = true;
// One-time note for people updating from a version with built-in sleep caps (10 PM / 11 PM) and a fixed 6:00 AM school leave time.
(() => {
  if (store.get('capsNote', false)) return;
  const existing = store.get('setup', false) || store.get('welcomed', false);
  store.set('capsNote', true);
  if (!existing) return;
  const msg = (capsOn() ? '' : 'Sleep caps are now off until you set them. ') + 'School leave time is now a setting' + (LEAVE === 6 * 60 ? ' (still 6:00 AM).' : '.');
  setTimeout(() => toast(msg, 'Settings', () => { setTab('settings'); setPageOpen('sched'); }), (window.__bootMin || 0) + 1800);
})();      // the app has loaded: from here (and after a short moment) a tap on the loading screen skips it
setTimeout(() => { const b = document.getElementById('boot'); if (b) b.classList.add('ready'); }, Math.max(0, 1200 - (Date.now() - (window.__t0 || Date.now()))));

EDUI = initEdUI({ $, fmt, range, wins, getWake: () => wake, WIN_STYLE, ICONS, guessIcon, ICON_GROUPS, onColor, esc, toVal, updateIconBtn });
EDUI.enhanceTimes($('#sleep')); EDUI.enhanceTimes($('#leaveBox'));
// ---- Settings: dropdowns become switches and previews, action buttons become icon rows ----
{
  const PV = { dark:['#1c1c1e', '#2c2c2e'], light:['#f3f5fb', '#ffffff'], midnight:['#000000', '#111113'], slate:['#121a26', '#1b2536'], forest:['#111a15', '#1a261f'], warm:['#f6f0e4', '#fffdf8'], auto:['#1c1c1e', '#f3f5fb'] };
  const segFor = (id, theme) => {
    const sel = $('#' + id); if (!sel) return;
    const row = sel.closest('.capRow'); row.classList.add('segRow'); sel.hidden = true;
    const box = document.createElement('div'); box.className = theme ? 'thmGrid' : 'segCtl'; if (!theme && sel.options.length > 3) box.classList.add('seg4'); row.appendChild(box);
    const paint = () => { box.innerHTML = [...sel.options].map(o => '<button type="button" data-v="' + esc(o.value) + '" class="' + (o.value === sel.value ? 'on' : '') + '">' + (theme ? '<i style="background:linear-gradient(135deg,' + (PV[o.value] || PV.dark)[0] + ' 0 52%,' + (PV[o.value] || PV.dark)[1] + ' 52%)"></i>' : '') + esc(o.textContent.replace(' (black)', '')) + '</button>').join(''); };
    box.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; sel.value = b.dataset.v; sel.dispatchEvent(new Event('change', { bubbles:true })); paint(); });
    paint();
  };
  segFor('thSel', true); segFor('chrSel'); segFor('clkSel'); segFor('txSel');
  { const ar = $('#accRow'); if (ar && ar.closest('.capRow')) ar.closest('.capRow').classList.add('segRow'); }
  const ROW_IC = {
    exp:'<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', shareBk:'<path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/>', imp:'<path d="M12 20V9M8 13l4-4 4 4M5 4h14"/>', snapBtn:'<rect x="3.5" y="6" width="17" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/>',
    clrAll:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', icsBtn:'<path d="M7 3h7l5 5v13H7zM14 3v5h5"/>', rst:'<path d="M4 12a8 8 0 108-8M4 4v5h5"/>', editToggle:'<path d="M4 20l4-1 11-11-3-3L5 16z"/>', replayWel:'<path d="M8 5l11 7-11 7z"/>' };
  const ROW_COL = { exp:'#e0707a', shareBk:'#e0707a', imp:'#e0707a', snapBtn:'#e0707a', icsBtn:'#5fae6b', editToggle:'#e3a13a', replayWel:'#5e96cb' };
  Object.keys(ROW_IC).forEach(id => {
    const b = $('#' + id); if (!b || b.classList.contains('rowBtn')) return;
    const red = id === 'clrAll' || id === 'rst';
    b.classList.add('rowBtn'); if (red) b.classList.add('rowRed');
    b.innerHTML = '<span class="rbT">' + esc(b.textContent) + '</span>';
    b.insertAdjacentHTML('afterbegin', '<span class="rbI" style="background:' + (red ? '#f87171' : ROW_COL[id]) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ROW_IC[id] + '</svg></span>');
  });
}

