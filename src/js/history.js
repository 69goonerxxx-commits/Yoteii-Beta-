// History tab: pure functions that turn saved data into HTML. main.js passes the data in and handles the taps.
// H:     { '2026-10-21': { wake, rows:[{ w, id, t, s, u, sug, done, n }], note, types }, ... }  (today may be included, built live)
// range: one of 'week' | 'month' | 'all', plus an offset (0 = current, -1 = previous, ...)
import { esc } from './util.js';
import { isoLocal, parseDay, cmpDay } from './dates.js';
import { logByDay } from './todo.js';

export const HIT = 0.7;                       // a day counts toward the streak at 70% or more
const GRACE_NOTE = 'A day counts at 70% or more. One missed day is forgiven, then you need 7 more days before the next one is.';

const addD = (ds, n) => { const d = parseDay(ds); d.setDate(d.getDate() + n); return isoLocal(d); };
const monday = ds => { const d = parseDay(ds), wd = d.getDay(); d.setDate(d.getDate() + (wd === 0 ? -6 : 1 - wd)); return isoLocal(d); };
const fS = ds => parseDay(ds).toLocaleDateString(undefined, { month:'short', day:'numeric' });
const fW = ds => parseDay(ds).toLocaleDateString(undefined, { weekday:'long' });
const fWS = ds => parseDay(ds).toLocaleDateString(undefined, { weekday:'short' });
const pc = x => Math.round(x * 100);

// ---- numbers -------------------------------------------------------------
export function dayStat(h){
  const rows = ((h && h.rows) || []).filter(r => r.u > 0 && !r.sug), done = rows.filter(r => r.done).length;
  return { planned:rows.length, done, pct:rows.length ? done / rows.length : null, rows };
}

// Streak with a capped grace day. P maps a day to its completion (0..1) or null.
// A day counts at 70% or more. One missed day (or a day with no record) is forgiven, then 7 more hit days must pass before the next one is.
// A second miss too soon, or two misses in a row, ends the streak. Today is still in progress, so it never counts as a miss.
export const GRACE_EVERY = 7;
export function streaks(P, today){
  const ds = Object.keys(P).filter(d => P[d] !== null && P[d] !== undefined).sort(cmpDay);
  if (!ds.length) return { cur:0, best:0, graces:0, pending:false, next:0 };
  let run = 0, best = 0, miss = 0, graces = 0, since = Infinity;      // since: hit days after the last grace day (Infinity = none used yet)
  for (let d = ds[0]; d <= today; d = addD(d, 1)){
    const p = P[d] === undefined ? null : P[d];
    if (p !== null && p >= HIT){
      if (miss === 1 && run > 0){ graces++; since = 0; }
      else if (run > 0 && since !== Infinity) since++;
      run++; miss = 0; best = Math.max(best, run);
    } else if (d !== today){
      miss++;
      if (miss >= 2 || !(run > 0 && since >= GRACE_EVERY)){ run = 0; graces = 0; since = Infinity; miss = Math.max(miss, 2); }
    }
  }
  return { cur:run, best, graces:run ? graces : 0, pending:run > 0 && miss === 1, next:run > 0 && since !== Infinity ? Math.max(0, GRACE_EVERY - since) : 0 };
}

export function rangeFor(kind, off, today, first){
  let start, end;
  if (kind === 'week'){ start = addD(monday(today), off * 7); end = addD(start, 6); }
  else if (kind === 'month'){
    const t = parseDay(today);
    start = isoLocal(new Date(t.getFullYear(), t.getMonth() + off, 1)); end = isoLocal(new Date(t.getFullYear(), t.getMonth() + off + 1, 0));
  } else { start = first && first < today ? first : today; end = today; off = 0; }
  const last = end < today ? end : today, days = [];
  for (let d = start; d <= last; d = addD(d, 1)) days.push(d);
  let title, sub = fS(start) + ' to ' + fS(end);
  if (kind === 'week') title = off === 0 ? 'This week' : off === -1 ? 'Last week' : sub;
  else if (kind === 'month') title = parseDay(start).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  else { title = 'All time'; sub = days.length + ' day' + (days.length === 1 ? '' : 's') + ' of records'; }
  return { kind, off, start, end, days, title, sub: title === sub ? '' : sub, canPrev:kind !== 'all' && !!first && start > first, canNext:kind !== 'all' && off < 0 };
}

function collect(H, days){
  const o = { planned:0, done:0, tracked:[], win:{}, skip:{}, task:{} };
  days.forEach(ds => {
    const s = dayStat(H[ds]); if (!s.planned) return;
    o.planned += s.planned; o.done += s.done; o.tracked.push({ ds, pct:s.pct });
    s.rows.forEach(r => {
      if (r.w){ const w = o.win[r.w] || (o.win[r.w] = { d:0, t:0 }); w.t++; if (r.done) w.d++; }
      if (!r.done) o.skip[r.t] = (o.skip[r.t] || 0) + 1;
      const t = o.task[r.id] || (o.task[r.id] = { t:r.t, d:0, n:0 }); t.n++; if (r.done) t.d++;
    });
  });
  o.pct = o.planned ? o.done / o.planned : null;
  return o;
}
const level = p => p === null ? 0 : p < .3 ? 1 : p < HIT ? 2 : p < .9 ? 3 : 4;

// ---- pieces --------------------------------------------------------------
// Chevron and section helpers reuse the Inbox and To-do classes so the tabs look the same.
const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>', CHEV_R = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const CHEV_D = open => '<svg viewBox="0 0 24 24" aria-hidden="true" class="' + (open ? 'open' : '') + '"><path d="M6 9l6 6 6-6"/></svg>';
const label = (t, right) => '<div class="ibSec"><span>' + t + '</span>' + (right ? '<span>' + right + '</span>' : '') + '</div>';
// A section that can be collapsed, like To-do's. The card inside is skipped when collapsed.
function fold(key, title, body, ctx, count){
  if (!body) return '';
  const open = !(ctx.hide && ctx.hide.has(key));
  return '<section class="tdSec"><button type="button" class="tdSecH" data-hsec="' + key + '" aria-expanded="' + open + '"><span>' + title + '</span><span class="tdR">' + (count !== undefined ? '<span class="tdN">' + count + '</span>' : '') + CHEV_D(open) + '</span></button>' + (open ? body : '') + '</section>';
}
const card = (inner, cls) => '<div class="sleep hvCard' + (cls ? ' ' + cls : '') + '">' + inner + '</div>';

function controls(R){
  const seg = [['week', 'Week'], ['month', 'Month'], ['all', 'All']].map(([k, l]) => '<button type="button" data-hr="' + k + '" class="' + (R.kind === k ? 'on' : '') + '" aria-pressed="' + (R.kind === k) + '">' + l + '</button>').join('');
  const sub = R.sub ? '<small>' + esc(R.sub) + '</small>' : '';
  const jump = R.off < 0 ? '<button type="button" class="tdLink calTd" data-hn="0">' + (R.kind === 'week' ? 'This week' : 'This month') + '</button>' : '';
  const nav = R.kind === 'all' ? '<div class="calHead hvHead"><h2>' + esc(R.title) + sub + '</h2></div>'
    : '<div class="calHead hvHead"><h2>' + esc(R.title) + sub + '</h2>' + jump + '<button type="button" class="calNav" data-hn="-1" aria-label="Earlier"' + (R.canPrev ? '' : ' disabled') + '>' + CHEV_L + '</button><button type="button" class="calNav" data-hn="1" aria-label="Later"' + (R.canNext ? '' : ' disabled') + '>' + CHEV_R + '</button></div>';
  return '<div class="ibSeg hvSeg" role="group" aria-label="Range">' + seg + '</div>' + nav;
}

// The three stat tiles, like the Inbox, then one short line each for the change and the streak.
function tiles(R, S, prev, sk){
  const has = S.planned > 0;
  const best = has ? S.tracked.filter(x => x.pct > 0).sort((a, b) => b.pct - a.pct || cmpDay(b.ds, a.ds))[0] : null;
  const against = R.kind === 'week' ? 'the week before' : 'the month before';
  let delta = '';
  if (has && prev && prev.planned){ const d = pc(S.pct) - pc(prev.pct); delta = '<span class="hvDelta ' + (d > 0 ? 'up' : '') + '">' + (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d) + ' pts vs ' + against + '</span>'; }
  const cap = [delta, best ? 'Best day: ' + (R.kind === 'week' ? fW(best.ds) : fWS(best.ds) + ', ' + fS(best.ds)) + ' (' + pc(best.pct) + '%)' : ''].filter(Boolean).join(' · ');
  return '<div class="ibSt hvSt"><div><b>' + (has ? pc(S.pct) + '%' : '–') + '</b><span>Completion</span></div><div><b>' + (has ? S.done + '/' + S.planned : '–') + '</b><span>Tasks done</span></div><div class="hvAcc"><b>' + sk.cur + 'd</b><span>Streak, best ' + sk.best + '</span></div></div>' +
    (has ? (cap ? '<p class="hvCap">' + cap + '</p>' : '') : '<p class="hvCap">No tracked days in this range.</p>') +
    '<p class="hvCap">' + streakLine(sk) + '</p><details class="hvRule"><summary>How streaks work</summary><p class="wn">' + (sk.graces ? 'This streak includes ' + sk.graces + ' grace day' + (sk.graces === 1 ? '' : 's') + '. ' : '') + GRACE_NOTE + '</p></details>';
}
// One short status line under the streak. The full rule sits behind "How streaks work".
function streakLine(sk){
  if (sk.pending) return 'Missed a day. Finish 70% today to keep it.';
  if (!sk.cur) return 'Finish 70% of a day to start a streak.';
  return sk.next > 0 ? 'Next grace day in ' + sk.next + ' day' + (sk.next === 1 ? '' : 's') + '.' : 'A grace day is ready if you need it.';
}

function calendar(R, H, today){
  const gs = monday(R.start), ge = addD(monday(R.end), 6), lab = R.kind !== 'week', cells = [];
  let head = '';
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(x => { head += '<span class="hvH">' + x + '</span>'; });
  for (let d = gs, i = 0; d <= ge; d = addD(d, 1), i++){
    if (lab && i % 7 === 0) cells.push('<span class="hvL">' + fS(d) + '</span>');
    if (d < R.start || d > R.end){ cells.push('<span class="calC hvC out"></span>'); continue; }
    const s = H[d] ? dayStat(H[d]) : { pct:null }, lv = level(s.pct), fut = d > today;
    const aria = fW(d) + ', ' + fS(d) + ': ' + (s.pct === null ? 'no record' : pc(s.pct) + '% done');
    cells.push('<button type="button" class="calC hvC l' + lv + (d === today ? ' today' : '') + (fut ? ' fut' : '') + '" data-d="' + d + '" aria-label="' + esc(aria) + '"><b>' + parseDay(d).getDate() + '</b>' + (R.kind === 'week' ? '<em>' + (s.pct === null ? '–' : pc(s.pct) + '%') + '</em>' : '') + '</button>');
  }
  return card('<div class="hvGrid ' + R.kind + (lab ? ' lab' : '') + '">' + (lab ? '<span></span>' : '') + head + cells.join('') + '</div>' +
    '<div class="hvLegend"><span>Less</span><b class="hvC l1"></b><b class="hvC l2"></b><b class="hvC l3"></b><b class="hvC l4"></b><span>More</span></div><p class="wn hvKey">Brighter days are 70% or more and count toward your streak. Tap a day to open it.</p>');
}

function review(R, S, names){
  if (S.tracked.length < 3) return '';
  const avg = pc(S.pct), best = S.tracked.slice().sort((a, b) => b.pct - a.pct || cmpDay(b.ds, a.ds))[0];
  const wk = Object.keys(S.win).filter(k => S.win[k].t >= 3 && names[k]).sort((a, b) => S.win[b].d / S.win[b].t - S.win[a].d / S.win[a].t);
  const sk = Object.entries(S.skip).filter(x => x[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const tip = avg < 50 ? 'A lighter plan might serve you better. Shorten or drop the most-skipped tasks.' : avg >= 80 ? 'Strong stretch. Keep what works, and maybe add one stretch goal.' : 'Solid. Put your hardest task in your strongest window.';
  return card('<ul><li>Average completion ' + avg + '% over ' + S.tracked.length + ' tracked days.</li><li>Best day: ' + fW(best.ds) + (R.kind === 'week' ? '' : ', ' + fS(best.ds)) + ' (' + pc(best.pct) + '%).</li>' +
    (wk.length ? '<li>Strongest window: ' + esc(names[wk[0]]) + '.</li>' : '') + (sk.length ? '<li>Most skipped: ' + sk.map(x => esc(x[0]) + ' (' + x[1] + 'x)').join(', ') + '.</li>' : '') + '</ul><p>' + tip + '</p>', 'about');
}

function energyData(R, S, ctx){
  const names = ctx.names, rs = (ctx.energy || []).filter(r => r.v >= 1 && r.v <= 5), set = new Set(R.days);
  const ks = Object.keys(S.win).filter(k => S.win[k].t >= 5 && names[k]).sort((a, b) => S.win[b].d / S.win[b].t - S.win[a].d / S.win[a].t);
  const by = {}; rs.filter(r => set.has(r.d)).forEach(r => { const o = by[r.w] || (by[r.w] = { s:0, n:0 }); o.s += r.v; o.n++; });
  return { ks, by, total:rs.length };
}
function energy(R, S, ctx){
  const E = energyData(R, S, ctx), names = ctx.names;
  if (E.ks.length < 2) return '';
  const rate = k => S.win[k].d / S.win[k].t, best = E.ks[0], worst = E.ks[E.ks.length - 1];
  const rated = Object.keys(E.by).filter(k => names[k] && E.by[k].n >= 2).sort((a, b) => E.by[b].s / E.by[b].n - E.by[a].s / E.by[a].n);
  const showR = E.total >= 5 && rated.length >= 2, av = k => E.by[k] && E.by[k].n >= 2 ? E.by[k].s / E.by[k].n : null;
  let line = 'You finish the most in ' + esc(names[best]) + ' (' + pc(rate(best)) + '%) and the least in ' + esc(names[worst]) + ' (' + pc(rate(worst)) + '%).';
  if (showR && rated[0] !== best) line += ' You rate your energy highest in ' + esc(names[rated[0]]) + '.'; else line += ' Try putting your hardest tasks in ' + esc(names[best]) + '.';
  const sug = ctx.rhySug || '';   // the My rhythm suggestion, built in main.js
  const rows = E.ks.map(k => { const a = av(k); return '<div class="trow"><span class="tlab wide">' + esc(names[k]) + '</span><div class="tbar"><div class="tfill" style="width:' + pc(rate(k)) + '%"></div></div><span class="tpct">' + pc(rate(k)) + '%</span>' + (showR ? '<span class="hvEn"' + (a ? ' style="background:' + ctx.enCol[Math.round(a) - 1] + '"' : '') + '>' + (a ? a.toFixed(1) : '–') + '</span>' : '') + '</div>'; }).join('');
  return card('<p class="wn">' + line + '</p><div class="hvEnH"><span>Tasks finished</span>' + (showR ? '<span>Energy</span>' : '') + '</div>' + rows + sug);
}

// Finished to-dos for the range, from the log kept by the To-do tab.
function todosDone(R, ctx){
  const by = logByDay(ctx.todoLog, R.days), ds = Object.keys(by).sort(cmpDay).reverse(), n = ds.reduce((a, d) => a + by[d].length, 0);
  const span = R.kind === 'week' ? (R.off === 0 ? 'this week' : R.off === -1 ? 'last week' : 'that week') : R.kind === 'month' ? 'in ' + parseDay(R.start).toLocaleDateString(undefined, { month:'long' }) : 'all time';
  if (!n) return { n:0, html:card('<p class="wn">Tick off a to-do and it shows up here.</p>') };
  const list = ds.map(d => '<p class="hd">' + fWS(d) + ', ' + fS(d) + '</p>' + by[d].map(x => '<p class="hl ok">' + esc(x.t) + '</p>').join('')).join('');
  return { n, html:card('<p class="wkBig"><b>' + n + '</b> to-do' + (n === 1 ? '' : 's') + ' done <span>' + span + '</span></p><details class="hvRule"><summary>Show the list</summary>' + list + '</details>') };
}
// To-dos finished on one day, shown inside that day's expanded record.
function todoDay(log, d){
  const xs = logByDay(log, [d])[d]; if (!xs) return '';
  return '<p class="hd">To-dos done</p>' + xs.map(x => '<p class="hl ok">' + esc(x.t) + '</p>').join('');
}

function consistent(S){
  const top = Object.values(S.task).filter(c => c.n >= 2).sort((a, b) => b.d / b.n - a.d / a.n || b.n - a.n).slice(0, 6);
  if (!top.length) return '';
  return card(top.map(c => '<div class="trow"><span class="tlab wide">' + esc(c.t) + '</span><div class="tbar"><div class="tfill" style="width:' + pc(c.d / c.n) + '%"></div></div><span class="tpct">' + c.d + '/' + c.n + '</span></div>').join(''));
}

// Energy over the day: your average rating for every half hour since waking, with your energy windows shaded behind it.
// d = { curve:[{from,to,n,mean}], bands:[{from,to,color,name}], peak:{from,to}|null, ratings, days, time(min) -> '8a' }
export function energyChart(d){
  if (!d || !d.curve) return '';
  const X0 = 26, W = 296, Y0 = 16, H = 112, BASE = Y0 + H, SPAN = 1080, x = m => X0 + W * Math.max(0, Math.min(SPAN, m)) / SPAN, y = v => BASE - (v / 5) * H;
  const bw = W / 36, esc2 = t => String(t).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  const bands = (d.bands || []).filter(b => b.to > 0 && b.from < SPAN).map(b => '<rect x="' + x(b.from).toFixed(1) + '" y="' + Y0 + '" width="' + (x(b.to) - x(b.from)).toFixed(1) + '" height="' + H + '" fill="' + esc2(b.color || '#888') + '" opacity=".16"/>').join('');
  const grid = [1, 3, 5].map(v => '<line x1="' + X0 + '" x2="' + (X0 + W) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)" stroke-width=".6"/><text x="' + (X0 - 5) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="var(--sec)">' + v + '</text>').join('');
  const bars = d.curve.filter(b => b.n > 0).map(b => { const hh = (b.mean / 5) * H; return '<rect x="' + (x(b.from) + 1).toFixed(1) + '" y="' + (BASE - hh).toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + hh.toFixed(1) + '" rx="2" fill="var(--accent)" opacity="' + (b.n >= 2 ? 1 : .4) + '"/>'; }).join('');
  const ticks = [0, 180, 360, 540, 720, 900, 1080].map(m => '<text x="' + x(m).toFixed(1) + '" y="' + (BASE + 14) + '" text-anchor="middle" font-size="9" fill="var(--sec)">' + esc2(d.time(m)) + '</text>').join('');
  const pk = d.peak ? '<path d="M' + x(d.peak.from).toFixed(1) + ' ' + (Y0 - 4) + 'h' + (x(d.peak.to) - x(d.peak.from)).toFixed(1) + '" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>' : '';
  const ok = d.curve.filter(b => b.n >= 2), hi = ok.length ? ok.reduce((a, b) => b.mean > a.mean ? b : a) : null, lo = ok.length ? ok.reduce((a, b) => b.mean < a.mean ? b : a) : null;
  const rg = b => d.long(b.from) + ' to ' + d.long(b.to);
  const label = 'Average energy rating by time of day' + (hi ? '. Highest ' + hi.mean.toFixed(1) + ' out of 5, around ' + rg(hi) : '');
  const sum = hi && lo && hi !== lo ? 'Highest average: <b>' + hi.mean.toFixed(1) + '</b> around ' + rg(hi) + '. Lowest: <b>' + lo.mean.toFixed(1) + '</b> around ' + rg(lo) + '.' : '';
  const leg = (d.bands || []).filter(b => b.to > 0 && b.from < SPAN).map(b => '<span><i style="background:' + esc2(b.color || '#888') + '"></i>' + esc2(b.name) + '</span>').join('');
  return '<div class="eChart"><svg viewBox="0 0 330 ' + (BASE + 22) + '" role="img" aria-label="' + esc2(label) + '">' + bands + grid + bars + pk + ticks + '</svg>' +
    '<div class="eLeg">' + leg + '</div>' +
    '<p class="wn">' + (sum ? sum + ' ' : '') + 'Based on ' + d.ratings + ' rating' + (d.ratings === 1 ? '' : 's') + ' over ' + d.days + ' day' + (d.days === 1 ? '' : 's') + '. Each bar is one half hour; faded bars have a single rating.' + (d.peak ? ' The line on top marks your likely peak.' : '') + '</p></div>';
}

// What is still locked, with progress, so cards do not just appear without explanation.
export function unlocks(R, S, ctx){
  const E = energyData(R, S, ctx), L = [];
  if (S.tracked.length < 3) L.push({ t:'Review', d:'Track 3 days', n:S.tracked.length, of:3 });
  if (E.ks.length < 2) L.push({ t:'Energy by window', d:'Finish 5 tasks in 2 windows', n:Object.keys(S.win).filter(k => S.win[k].t >= 5 && ctx.names[k]).length, of:2 });
  else if (E.total < 5) L.push({ t:'Energy ratings', d:'Add 5 energy check-ins on the Timeline', n:E.total, of:5 });
  return L;
}
function coming(L){
  if (!L.length) return '';
  return label('Coming up') + card(L.map(x => '<div class="hvUp"><div><b>' + x.t + '</b><span>' + x.d + '</span></div><div class="hvUpBar"><div class="tbar"><div class="tfill" style="width:' + Math.min(100, Math.round(x.n / x.of * 100)) + '%"></div></div><em>' + x.n + '/' + x.of + '</em></div></div>').join(''));
}

// Nothing recorded yet: the same empty state the Inbox and To-do use.
function emptyState(ic){
  return '<div class="ibGhost" aria-hidden="true"><div><i></i><i></i></div><span>' + ic.cal + '</span><span>' + ic.check + '</span></div>' +
    '<div class="ibEmpty">' + ic.art + '<h2>Your days will add up here</h2><p class="wn">Tick off tasks on your Timeline and this page shows how your days and weeks are going.</p><ul class="ibTips">' +
    '<li><span>' + ic.cal + '</span>Your calendar fills in as you go</li><li><span>' + ic.chk + '</span>70% or more counts toward your streak</li><li><span class="s">' + ic.check + '</span>Review unlocks after 3 tracked days</li></ul></div>';
}

function list(R, H, today, ctx){
  const days = R.days.filter(d => H[d] && dayStat(H[d]).planned).sort((a, b) => cmpDay(b, a));
  if (!days.length) return '<p class="wn">No days in this range.</p>';
  const groups = [], seen = {};
  days.forEach(d => { const m = monday(d); if (!seen[m]){ seen[m] = { m, ds:[] }; groups.push(seen[m]); } seen[m].ds.push(d); });
  return groups.map(g => {
    const S = collect(H, g.ds);
    const items = g.ds.map(d => {
      const h = H[d], s = dayStat(h), lv = level(s.pct), now = d === today;
      return '<details class="hday" data-d="' + d + '"' + (ctx.open && ctx.open.has(d) ? ' open' : '') + '><summary><span class="bt">' + parseDay(d).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' }) + (now ? ' <small class="hvNow">Today</small>' : '') + '</span><span class="bm">' + s.done + ' of ' + s.planned + ' done' + (Number.isFinite(h.wake) ? ', woke ' + ctx.fmtTime(h.wake) : now ? ', in progress' : '') + '</span><b class="hvPill l' + lv + '">' + pc(s.pct) + '%</b></summary><div class="hb">' + ctx.dayInner(h) + todoDay(ctx.todoLog, d) + (now ? '' : '<button class="hdel" data-hd="' + esc(d) + '">Delete this record</button>') + '</div></details>';
    }).join('');
    return label(fS(g.m) + ' to ' + fS(addD(g.m, 6)), pc(S.pct) + '% · ' + g.ds.length + ' day' + (g.ds.length === 1 ? '' : 's')) + '<div class="ibSheet hvGroup">' + items + '</div>';
  }).join('');
}

// ---- entry point ---------------------------------------------------------
// ctx: { H, today, kind, off, names:{window:name}, energy:[{v,d,w,o}], chrono, peakMid, enCol:[5 colors], todoLog, hide:Set, ic:{art,cal,chk,check}, open:Set, dayInner(h), fmtTime(min) }
export function historyHtml(ctx){
  const H = ctx.H, today = ctx.today;
  const firstRec = Object.keys(H).filter(d => dayStat(H[d]).planned).sort(cmpDay)[0] || null;
  const firstLog = (ctx.todoLog || []).map(x => x && x.d).filter(Boolean).sort(cmpDay)[0] || null;      // finished to-dos can be older than the first routine record
  const first = [firstRec, firstLog].filter(Boolean).sort(cmpDay)[0] || null;
  const R = rangeFor(ctx.kind, ctx.off, today, first), S = collect(H, R.days);
  const prev = R.kind === 'all' ? null : collect(H, rangeFor(R.kind, R.off - 1, today, first).days);
  const P = {}; Object.keys(H).forEach(d => { P[d] = dayStat(H[d]).pct; });
  const sk = streaks(P, today), unl = unlocks(R, S, ctx);
  if (!first) return { trends: emptyState(ctx.ic) + coming(unl), list: '', range: R };
  const td = todosDone(R, ctx);
  return {
    trends: controls(R) + tiles(R, S, prev, sk) + label('Calendar') + calendar(R, H, today) + fold('review', 'Review', review(R, S, ctx.names), ctx) + fold('todos', 'To-dos done', td.html, ctx, td.n) +
      fold('energy', 'Energy by window', energy(R, S, ctx), ctx) + fold('eday', 'Energy over the day', ctx.eChart ? card(energyChart(ctx.eChart)) : '', ctx) + fold('consistent', 'Most consistent tasks', consistent(S), ctx) + (S.planned ? coming(unl) : ''),
    list: list(R, H, today, ctx), range: R
  };
}
