// My rhythm: learns where your energy really peaks from your check-ins and proposes one shift for every energy window.
// Pure functions only (no DOM, no storage), so it can be tested on its own, like engine.js.
// A check-in looks like { v:1-5, at:minutes since midnight, o:minutes since you woke, w:window id, d:'YYYY-MM-DD' }.
// Shifts are minutes against the default windows ("In between" = 0). Nothing here changes your schedule; it only suggests.
import { isIso } from './dates.js';

export const R = Object.freeze({
  MIN_RATINGS: 15, MIN_DAYS: 5,          // below this the app says nothing; from here on it is "still learning"
  SUGGEST_RATINGS: 24, SUGGEST_DAYS: 7,  // a suggestion needs more: with fewer, simulated runs were wrong by 45+ min too often
  LOOKBACK_DAYS: 90, HALF_LIFE_DAYS: 21, // recent days count more
  LEARN_FROM: 60, LEARN_TO: 900,         // the first hour (sleep inertia) and the night routine say nothing about your peak
  PEAK_MID: 270, SPAN: 180, SEARCH: 150, // default Sustained Peak: centre 4.5 h after waking, 3 h wide; look +-2.5 h around it
  MAX_SHIFT: 90, STEP: 5, MIN_GAP: 30,   // the shift is capped, rounded to 5 min, and only suggested when it moves at least 30 min
  WAKE_TOL: 90, MAX_ODD: 0.4,            // days that start 90+ min from your usual wake time are left out; too many of them = irregular
  Z_MEDIUM: 3, Z_HIGH: 4, KERNEL_SD: 55, PRIOR: 2, MIN_SPAN_N: 4, MIN_SIDE_N: 2, MIN_SPREAD: 0.5, MIN_CONTRAST: 0.3,
  SNOOZE_DAYS: 14, SNOOZE_RATINGS: 10,   // after "Not now": ask again after 2 weeks or 10 new ratings
});

const num = x => typeof x === 'number' && Number.isFinite(x);
const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const roundStep = x => Math.round(x / R.STEP) * R.STEP;
const circ = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };

// Keep only usable check-ins from the last 90 days. Returns { v, o, d, age, wake } (wake = that day's wake time, from at - o).
export function clean(ratings, today){
  const out = [], t = isIso(today) ? dayNum(today) : null;
  if (!Array.isArray(ratings)) return out;
  for (const r of ratings){
    if (!r || !num(r.v) || r.v < 1 || r.v > 5 || !num(r.o) || !num(r.at) || !isIso(r.d)) continue;
    const age = t === null ? 0 : t - dayNum(r.d);
    if (age < 0 || age > R.LOOKBACK_DAYS) continue;
    out.push({ v:r.v, o:r.o, d:r.d, age, wake:((r.at - r.o) % 1440 + 1440) % 1440 });
  }
  return out;
}
const weight = age => Math.pow(0.5, age / R.HALF_LIFE_DAYS);

function usualWake(rs){
  const ref = rs[0].wake, pts = rs.map(r => ({ x:((r.wake - ref + 720) % 1440 + 1440) % 1440 - 720, w:weight(r.age) })).sort((a, b) => a.x - b.x);
  let acc = 0; const half = pts.reduce((a, p) => a + p.w, 0) / 2;
  for (const p of pts){ acc += p.w; if (acc >= half) return ((ref + p.x) % 1440 + 1440) % 1440; }
  return ref;
}

// Best 3-hour stretch: for every candidate centre, the recency-weighted average of the ratings around it, counting ratings near the
// centre more (so a dip on one shoulder does not drag the answer), pulled gently toward the overall average so a couple of lucky
// ratings cannot win. A stretch only counts if it has enough ratings and data on both sides of it.
function findPeak(used, mu){
  const lo = R.PEAK_MID - R.SEARCH, hi = R.PEAK_MID + R.SEARCH, half = R.SPAN / 2, cands = [];
  for (let c = lo; c <= hi; c += R.STEP){
    let sw = 0, swv = 0, n = 0, before = 0, after = 0;
    for (const r of used){
      const dist = Math.abs(r.o - c);
      if (dist <= half) n++; else if (r.o < c) before++; else after++;
      if (dist <= half + R.KERNEL_SD){ const w = weight(r.age) * Math.exp(-0.5 * (dist / R.KERNEL_SD) * (dist / R.KERNEL_SD)); sw += w; swv += w * r.v; }
    }
    if (n < R.MIN_SPAN_N || before < R.MIN_SIDE_N || after < R.MIN_SIDE_N) continue;
    cands.push({ c, score:(swv + R.PRIOR * mu) / (sw + R.PRIOR), mean:swv / sw });
  }
  if (!cands.length) return null;
  let bi = 0; cands.forEach((x, i) => { if (x.score > cands[bi].score + 1e-9) bi = i; });
  const best = cands[bi].score; let a = bi, z = bi;      // the flat top around the best score: use its centre
  while (a > 0 && cands[a - 1].c === cands[a].c - R.STEP && cands[a - 1].score >= best - 0.05) a--;
  while (z < cands.length - 1 && cands[z + 1].c === cands[z].c + R.STEP && cands[z + 1].score >= best - 0.05) z++;
  const centre = roundStep((cands[a].c + cands[z].c) / 2);
  const inside = used.filter(r => Math.abs(r.o - centre) <= half), outside = used.filter(r => Math.abs(r.o - centre) > half);
  const avg = rs => { let s = 0, t = 0; rs.forEach(r => { const w = weight(r.age); s += w * r.v; t += w; }); return t ? s / t : 0; };
  return { centre, contrast:avg(inside) - avg(outside), nIn:inside.length, nOut:outside.length };
}
const wmean = rs => { let s = 0, t = 0; rs.forEach(r => { const w = weight(r.age); s += w * r.v; t += w; }); return t ? s / t : 0; };
const sd = (rs, mu) => { let s = 0, t = 0; rs.forEach(r => { const w = weight(r.age); s += w * (r.v - mu) * (r.v - mu); t += w; }); return t ? Math.sqrt(s / t) : 0; };
const nDays = rs => new Set(rs.map(r => r.d)).size;

export function analyze(ratings, today){
  const all = clean(ratings, today), base = all.filter(r => r.o >= R.LEARN_FROM && r.o < R.LEARN_TO);
  const res = { status:'need-data', total:all.length, ratings:base.length, days:nDays(base), shift:0, rawShift:0, capped:false, centre:null, contrast:0, confidence:'none', usualWake:null, skippedDays:0 };
  if (base.length < R.MIN_RATINGS || res.days < R.MIN_DAYS) return res;

  const usual = usualWake(base); res.usualWake = usual;
  const used = base.filter(r => circ(r.wake, usual) <= R.WAKE_TOL);
  res.skippedDays = nDays(base) - nDays(used);
  if ((base.length - used.length) / base.length > R.MAX_ODD){ res.status = 'irregular'; return res; }
  res.ratings = used.length; res.days = nDays(used);
  if (used.length < R.MIN_RATINGS || res.days < R.MIN_DAYS) return res;

  const mu = wmean(used);
  if (sd(used, mu) < R.MIN_SPREAD){ res.status = 'flat'; return res; }
  const peak = findPeak(used, mu);
  if (!peak){ res.status = 'need-spread'; return res; }
  const se = Math.max(sd(used, mu), 0.3) * Math.sqrt(1 / peak.nIn + 1 / peak.nOut);   // how much a difference this big could be luck
  res.centre = peak.centre; res.contrast = Math.round(peak.contrast * 100) / 100; res.z = Math.round(peak.contrast / se * 10) / 10;
  if (peak.contrast < R.MIN_CONTRAST){ res.status = 'flat'; return res; }

  res.rawShift = peak.centre - R.PEAK_MID;
  res.shift = clamp(roundStep(res.rawShift), -R.MAX_SHIFT, R.MAX_SHIFT); res.capped = Math.abs(roundStep(res.rawShift)) > R.MAX_SHIFT;

  // How steady is it? Drop each day in turn and see how far the answer moves.
  const centres = [peak.centre];
  for (const d of new Set(used.map(r => r.d))){
    const rest = used.filter(r => r.d !== d), p = rest.length ? findPeak(rest, wmean(rest)) : null;
    if (p) centres.push(p.centre);
  }
  const wobble = Math.max(...centres) - Math.min(...centres); res.wobble = wobble;
  res.confidence = res.days >= 12 && used.length >= 36 && peak.contrast >= 0.7 && res.z >= R.Z_HIGH && wobble <= 25 ? 'high'
    : res.days >= R.SUGGEST_DAYS && used.length >= R.SUGGEST_RATINGS && peak.contrast >= 0.5 && res.z >= R.Z_MEDIUM && wobble <= 40 ? 'medium' : 'low';
  res.status = res.confidence === 'low' ? 'learning' : 'ready';
  return res;
}

// Average rating per 30 minutes since waking, for the "Energy over the day" chart. Uses every usable check-in.
export function curve(ratings, today){
  const rs = clean(ratings, today), out = [];
  for (let from = 0; from < 1080; from += 30){
    const b = rs.filter(r => r.o >= from && r.o < from + 30);
    out.push({ from, to:from + 30, n:b.length, mean:b.length ? Math.round(b.reduce((a, r) => a + r.v, 0) / b.length * 100) / 100 : null });
  }
  return out;
}

// A later shift can squeeze the windows before the night routine. This works out how far a shift can go before the last window before it
// (windFrom after waking) would have less than nightMin minutes left before the hard sleep cap. No hard cap set = no limit.
// It only ever limits how much LATER things move: it never pushes you earlier than the shift you already use.
export function guardNight({ wake, shift, current = 0, hardCap, nightMin, windFrom = 900 }){
  if (!num(hardCap) || !num(wake)) return { limited:false, shift, maxShift:Infinity, fits:true };
  const maxShift = hardCap - (num(nightMin) ? nightMin : 0) - (wake + windFrom);
  const ceil = Math.max(Math.floor(maxShift / R.STEP) * R.STEP, num(current) ? current : 0);
  const limited = shift > ceil, out = limited ? clamp(ceil, -R.MAX_SHIFT, shift) : shift;
  return { limited, shift:out, maxShift, fits:wake + windFrom + out + (num(nightMin) ? nightMin : 0) <= hardCap };
}

// Should the app offer the shift now? ctx: { current (shift in use), today, never, snooze:{at,n}|null, guard:{wake, hardCap, nightMin}|null }
export function suggest(a, ctx = {}){
  const current = num(ctx.current) ? ctx.current : 0, no = (reason, extra) => ({ show:false, reason, shift:a.shift, gap:Math.abs(a.shift - current), limited:false, ...extra });
  if (ctx.never) return no('never');
  if (a.status !== 'ready') return no('not-ready', { status:a.status });
  let target = a.shift, limited = false;
  if (ctx.guard){ const g = guardNight({ ...ctx.guard, shift:target, current }); target = g.shift; limited = g.limited; }
  const gap = Math.abs(target - current);
  if (gap < R.MIN_GAP) return { show:false, reason:limited ? 'night-guard' : 'small-gap', shift:target, gap, limited };
  const s = ctx.snooze;
  if (s && isIso(s.at) && isIso(ctx.today)){
    const days = dayNum(ctx.today) - dayNum(s.at), fresh = a.total - (num(s.n) ? s.n : 0);
    if (days < R.SNOOZE_DAYS && fresh < R.SNOOZE_RATINGS) return { show:false, reason:'snoozed', shift:target, gap, limited };
  }
  return { show:true, reason:limited ? 'limited' : 'ok', shift:target, gap, limited };
}

// Energy check-in nudges: `count` times a day, one in each equal slice of the learning range (1.5 h to 14 h after waking), so the ratings
// land at different times of day and on both sides of your peak. The times come from the date, so rebuilding the plan gives the same
// times, and every 5 minutes. Returns minutes after waking.
export function nudgeTimes(ds, count = 3){
  const lo = 90, hi = 840, n = Math.max(1, Math.min(6, Math.floor(count) || 1)), w = (hi - lo) / n, out = [];
  for (let i = 0; i < n; i++){
    let h = 2166136261; const s = String(ds) + '|' + i;
    for (let k = 0; k < s.length; k++){ h ^= s.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;   // mix the bits so neighbouring dates differ
    const f = (h >>> 0) / 4294967296;                               // 0 to 1, fixed by the date
    out.push(Math.round((lo + i * w + w * 0.15 + f * w * 0.7) / 5) * 5);
  }
  return out;
}
