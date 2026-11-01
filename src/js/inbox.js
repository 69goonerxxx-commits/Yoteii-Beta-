// Inbox logic that does not touch the page, so it can be tested on its own.
// An Inbox task is { id, t, note?, imp?, at? }. Tasks from before v4 only have id and t;
// their id ('i' + the time in base 36) still says when they were made.
export const DAY = 864e5;
export const SORTS = [['manual', 'Manual'], ['new', 'Newest first'], ['old', 'Oldest first'], ['az', 'A to Z']];

export function stampOf(x){
  if (x.at) return x.at;
  const n = parseInt(String(x.id || '').slice(1), 36);
  return n > 1577836800000 && n < Date.now() + DAY ? n : 0;       // between 2020 and tomorrow, or we do not know
}
export function daysAgo(x, now = Date.now()){
  const t = stampOf(x); if (!t) return null;
  const a = new Date(t), n = new Date(now);
  return Math.max(0, Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / DAY));
}
export function addedLabel(x, now = Date.now(), locale){
  const d = daysAgo(x, now); if (d === null) return '';
  if (d === 0) return 'Added today';
  if (d === 1) return 'Added yesterday';
  if (d < 7) return 'Added ' + d + ' days ago';
  const a = new Date(stampOf(x)), same = a.getFullYear() === new Date(now).getFullYear();
  return 'Added ' + a.toLocaleDateString(locale, same ? { month:'short', day:'numeric' } : { month:'short', day:'numeric', year:'numeric' });
}
export function sortList(list, key){
  const by = { new:(a, b) => stampOf(b) - stampOf(a), old:(a, b) => stampOf(a) - stampOf(b), az:(a, b) => String(a.t).localeCompare(String(b.t), undefined, { sensitivity:'base' }) }[key];
  return by ? list.slice().sort(by) : list.slice();                  // manual keeps the stored order
}
// Important tasks first, each group in the chosen order
export function groups(list, key){ return { imp:sortList(list.filter(x => x.imp), key), rest:sortList(list.filter(x => !x.imp), key) }; }
export function stats(list, now = Date.now()){
  const days = list.map(x => daysAgo(x, now)).filter(d => d !== null);
  return { total:list.length, imp:list.filter(x => x.imp).length, oldest:days.length ? Math.max(...days) : null };
}
// After a drag: `ids` is the new order of one group ('imp' or 'rest') as it is on screen. Returns the whole list in screen order.
export function applyOrder(list, key, group, ids){
  const g = groups(list, key), by = new Map(list.map(x => [x.id, x]));
  const moved = ids.map(id => by.get(id)).filter(Boolean), seen = new Set(moved.map(x => x.id));
  g[group].forEach(x => { if (!seen.has(x.id)) moved.push(x); });
  g[group] = moved;
  return [...g.imp, ...g.rest];
}
export function makeTask(t, { note, imp } = {}, now = Date.now()){
  const x = { id:'i' + now.toString(36), t:String(t).trim(), at:now };
  if (note && String(note).trim()) x.note = String(note).trim().slice(0, 300);
  if (imp) x.imp = true;
  return x;
}
export const insertNew = (list, x) => [x, ...list];                  // new tasks go to the top of their section
export function normalizePrefs(p){
  p = p && typeof p === 'object' ? p : {};
  return { f:p.f === 'imp' ? 'imp' : 'all', s:SORTS.some(([k]) => k === p.s) ? p.s : 'manual' };
}
