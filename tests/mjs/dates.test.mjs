// Tests for day keys and the v2 -> v3 data migration. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoLocal, parseDay, dowOf, cmpDay, isIso, legacyToIso } from '../../src/js/dates.js';
import { migrateDates, needsDateMigration, DATE_FMT } from '../../src/js/migrate.js';

test('isoLocal pads month and day, parseDay reverses it at local midnight', () => {
  assert.equal(isoLocal(new Date(2026, 0, 5)), '2026-01-05');
  const d = parseDay('2026-10-11');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 9, 11, 0]);
  assert.equal(dowOf('2026-10-11'), 0);   // a Sunday
});
test('ISO days sort in date order', () => {
  assert.deepEqual(['2026-10-11', '2025-12-31', '2026-02-03'].sort(cmpDay), ['2025-12-31', '2026-02-03', '2026-10-11']);
});
test('legacyToIso converts v2 keys, passes ISO through, rejects the rest', () => {
  assert.equal(legacyToIso('Sun Oct 11 2026'), '2026-10-11');
  assert.equal(legacyToIso('Thu Jan 01 2026'), '2026-01-01');
  assert.equal(legacyToIso('2026-10-11'), '2026-10-11');
  assert.equal(legacyToIso('Sun Feb 30 2026'), null);      // not a real date
  assert.equal(legacyToIso('hello'), null);
  assert.equal(legacyToIso(undefined), null);
  assert.equal(isIso('2026-1-1'), false);
});
test('every day of a leap year round-trips through the v2 format', () => {
  for (let i = 0; i < 366; i++){
    const d = new Date(2028, 0, 1 + i);
    assert.equal(legacyToIso(d.toDateString()), isoLocal(d));
  }
});

const J = JSON.stringify;
const v2 = () => ({
  plans: J({ 'Sun Oct 11 2026': { w: 300, n: 'x' }, 'Mon Oct 12 2026': { w: 310 } }),
  hist: J({ 'Sat Oct 10 2026': { rows: [], note: 'a' } }),
  taskNotes: J({ 'Sun Oct 11 2026_p1': 'note', 'Sat Oct 10 2026_my_task_2': 'n2' }),
  day: J({ date: 'Sun Oct 11 2026', types: { climb1: 'home' } }),
  done: J({ date: 'Sun Oct 11 2026', ids: ['a'] }),
  remSent: J({ d: 'Sun Oct 11 2026', ids: ['a'] }),
  energy: J([{ v: 3, d: 'Sat Oct 10 2026' }, { v: 4, d: 'Sun Oct 11 2026' }]),
  bkAsk: J('Sat Oct 10 2026'),
  blocks: J({ pre: [{ id: 'p1', t: 'Water' }] }), wake: J(300), lastBackup: J(1760000000000),
});

test('migration converts every place a day is stored', () => {
  const m = migrateDates(v2()), g = k => JSON.parse(m[k]);
  assert.deepEqual(Object.keys(g('plans')).sort(), ['2026-10-11', '2026-10-12']);
  assert.deepEqual(Object.keys(g('hist')), ['2026-10-10']);
  assert.deepEqual(Object.keys(g('taskNotes')).sort(), ['2026-10-10_my_task_2', '2026-10-11_p1']);
  assert.equal(g('day').date, '2026-10-11'); assert.equal(g('done').date, '2026-10-11');
  assert.equal(g('remSent').d, '2026-10-11');
  assert.deepEqual(g('energy').map(e => e.d), ['2026-10-10', '2026-10-11']);
  assert.equal(g('bkAsk'), '2026-10-10');
  assert.equal(g('plans')['2026-10-11'].n, 'x');          // values untouched
});
test('migration leaves unrelated data byte-for-byte alone and marks the new format', () => {
  const a = v2(), m = migrateDates(a);
  ['blocks', 'wake', 'lastBackup'].forEach(k => assert.equal(m[k], a[k]));
  assert.equal(m.dateFmt, J(DATE_FMT));
  assert.equal(needsDateMigration(a), true); assert.equal(needsDateMigration(m), false);
});
test('migration is idempotent and does not mutate its input', () => {
  const a = v2(), snap = JSON.stringify(a), once = migrateDates(a);
  assert.equal(JSON.stringify(a), snap);
  assert.deepEqual(migrateDates(once), once);
});
test('migration tolerates missing keys, damaged JSON and unknown formats', () => {
  assert.deepEqual(migrateDates({}), { dateFmt: J(DATE_FMT) });
  const m = migrateDates({ plans: '{oops', hist: J({ 'weird key': { rows: [] } }), taskNotes: J({ nounderscore: 'x' }), energy: J('nope') });
  assert.equal(m.plans, '{oops');
  assert.deepEqual(Object.keys(JSON.parse(m.hist)), ['weird key']);
  assert.deepEqual(Object.keys(JSON.parse(m.taskNotes)), ['nounderscore']);
  assert.equal(m.energy, J('nope'));
});
