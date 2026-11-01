// ============================================================
// TO-DO helpers: plain functions with no screen code, so they can be tested.
// Days are ISO strings like "2026-10-20" (see dates.js).
// ============================================================
import { isoLocal, parseDay } from './dates.js';

export function addDays(iso, n){ const d = parseDay(iso); d.setDate(d.getDate() + n); return isoLocal(d); }

const minOf = s => { const z = /^(\d{2}):(\d{2})$/.exec(s || ''); return z ? +z[1] * 60 + +z[2] : null; };

// Late means: not done, and its day has passed, or it is today and its time has passed.
export function isOverdue(x, today, nowMin){
  if (!x || x.done || !x.due) return false;
  if (x.due < today) return true;
  const m = minOf(x.dt);
  return x.due === today && m !== null && m < nowMin;
}
export const overdueCount = (list, today, nowMin) => (Array.isArray(list) ? list : []).filter(x => isOverdue(x, today, nowMin)).length;

// The date a quick chip stands for: 'today', 'tomorrow' or 'week' (a week from today).
export function quickDate(k, today){ return k === 'today' ? today : k === 'tomorrow' ? addDays(today, 1) : k === 'week' ? addDays(today, 7) : ''; }

// The Monday-first week that holds a day: seven ISO days.
export function weekDays(iso){
  const d = parseDay(iso), lead = (d.getDay() + 6) % 7, out = [];
  for (let i = 0; i < 7; i++) out.push(addDays(iso, i - lead));
  return out;
}

// The first day of the month that holds a day, moved by n months.
export function shiftMonth(iso, n){ const d = parseDay(iso); d.setMonth(d.getMonth() + n, 1); return isoLocal(d); }

// A month as a Monday-first grid: `lead` empty cells, then every day of the month.
export function monthGrid(iso){
  const d = parseDay(iso), y = d.getFullYear(), m = d.getMonth(), dim = new Date(y, m + 1, 0).getDate();
  const days = []; for (let i = 1; i <= dim; i++) days.push(isoLocal(new Date(y, m, i)));
  return { lead:(new Date(y, m, 1).getDay() + 6) % 7, days };
}

// ---- finished to-do log (feeds the History tab) ----
// One entry per completion: { id, t, d } = the to-do's id, its title, and the day it was ticked. A repeating to-do adds an entry each time.
export const LOG_DAYS = 90;
export function pruneLog(log, today){
  const cut = addDays(today, -LOG_DAYS);
  return (Array.isArray(log) ? log : []).filter(x => x && typeof x.d === 'string' && x.d >= cut).slice(-1000);
}
export function logDone(log, it, today){ return pruneLog([...(Array.isArray(log) ? log : []), { id:it.id, t:it.t, d:today }], today); }
// Ticking a to-do back to open removes its most recent entry.
export function unlogDone(log, id){
  const l = Array.isArray(log) ? log.slice() : [];
  for (let i = l.length - 1; i >= 0; i--) if (l[i].id === id){ l.splice(i, 1); break; }
  return l;
}
// { '2026-10-21': [entries], ... } for the days given
export function logByDay(log, days){
  const set = new Set(days), out = {};
  (Array.isArray(log) ? log : []).forEach(x => { if (x && set.has(x.d)) (out[x.d] = out[x.d] || []).push(x); });
  return out;
}
