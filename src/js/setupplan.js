// The rules behind the first-run setup, kept apart from the page so they can be tested.
// Yoteii has three day-type slots: Home (always there), a second one (School by default) and a third (Away by default).
// Setup lets you pick up to two more: Work or School (they share the second slot), Sick, or one of your own.
// With one pick, Away stays as the third type. With two, the picks take both slots and Away makes room.

export const RESERVED = ['home', 'work', 'school', 'sick', 'away'];

// Typical sleep need by age, in hours (adults 7 to 9). Shown as a guide only; nothing in the schedule uses it.
export function sleepRangeFor(age){
  if (!(age >= 1)) return null;
  if (age <= 2) return [11, 14];
  if (age <= 5) return [10, 13];
  if (age <= 12) return [9, 12];
  if (age <= 17) return [8, 10];
  if (age <= 64) return [7, 9];
  return [7, 8];
}

// A name for a day type you make yourself. Returns '' when it is fine, otherwise a short message.
export function ownNameError(raw){
  const n = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!n) return 'Give it a name.';
  if (n.length > 14) return 'Keep it to 14 characters.';
  if (RESERVED.includes(n.toLowerCase())) return n + ' is already a day type.';
  return '';
}

// picks: [{ kind:'work' | 'school' | 'sick' | 'own', name?, icon? }], in the order they were ticked.
// Returns { slotNames, icons, main, names } or { error }.
//   slotNames: what to rename the second ('school') and third ('away') slot to; a slot left at its default is left out.
//   icons:     icons for the day types you named yourself, by name.
//   main:      'school' when Work or School was picked (the day you head out, which gets usual days and a leave time), else null.
//   names:     the three day types you end up with, Home first.
export function planTypes(picks = []){
  const clean = [];
  for (const p of picks){
    if (!p || !['work', 'school', 'sick', 'own'].includes(p.kind)) continue;
    if (clean.some(c => c.kind === p.kind)) continue;
    clean.push(p);
  }
  if (clean.length > 2) return { error:'Home plus two is the most.' };
  if (clean.some(p => p.kind === 'work') && clean.some(p => p.kind === 'school')) return { error:'Work and School share one slot.' };
  const label = p => p.kind === 'work' ? 'Work' : p.kind === 'school' ? 'School' : p.kind === 'sick' ? 'Sick' : String(p.name || '').trim().replace(/\s+/g, ' ');
  for (const p of clean) if (p.kind === 'own' && ownNameError(p.name)) return { error:ownNameError(p.name) };
  const out = clean.find(p => p.kind === 'work' || p.kind === 'school') || null;
  const rest = clean.filter(p => p !== out);
  const second = out || rest.shift() || null;     // the 'school' slot
  const third = rest.shift() || null;             // the 'away' slot
  const slotNames = {}, icons = {};
  if (second && label(second) !== 'School') slotNames.school = label(second);
  if (third) slotNames.away = label(third);
  clean.forEach(p => { if (p.kind === 'own') icons[label(p)] = p.icon || 'star'; });
  return { slotNames, icons, main:out ? 'school' : null, names:['Home', slotNames.school || 'School', slotNames.away || 'Away'] };
}
