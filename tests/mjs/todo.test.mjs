import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, isOverdue, overdueCount, quickDate, weekDays, shiftMonth, monthGrid, logDone, unlogDone, pruneLog, logByDay, LOG_DAYS } from '../../src/js/todo.js';

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
test('isOverdue: day passed, or today with a passed time; never done or undated', () => {
  const td = '2026-10-20';
  assert.equal(isOverdue({ due:'2026-10-19' }, td, 0), true);
  assert.equal(isOverdue({ due:'2026-10-19', done:true }, td, 0), false);
  assert.equal(isOverdue({}, td, 0), false);
  assert.equal(isOverdue({ due:td }, td, 1000), false);
  assert.equal(isOverdue({ due:td, dt:'09:00' }, td, 10 * 60), true);
  assert.equal(isOverdue({ due:td, dt:'21:00' }, td, 10 * 60), false);
  assert.equal(isOverdue({ due:'2026-10-21', dt:'01:00' }, td, 1000), false);
});
test('overdueCount ignores bad input', () => {
  assert.equal(overdueCount(null, '2026-10-20', 0), 0);
  assert.equal(overdueCount([{ due:'2026-10-01' }, { due:'2026-10-01', done:true }, { due:'2026-11-01' }, { t:'x' }], '2026-10-20', 0), 1);
});
test('quickDate', () => {
  assert.equal(quickDate('today', '2026-10-20'), '2026-10-20');
  assert.equal(quickDate('tomorrow', '2026-10-20'), '2026-10-21');
  assert.equal(quickDate('week', '2026-10-28'), '2026-11-04');
  assert.equal(quickDate('none', '2026-10-20'), '');
});
test('weekDays is Monday first and holds the day', () => {
  const w = weekDays('2026-10-20');            // a Tuesday
  assert.deepEqual(w, ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepEqual(weekDays('2026-10-25')[0], '2026-10-19');   // Sunday belongs to the week before it
  assert.equal(weekDays('2026-10-19')[0], '2026-10-19');
});
test('shiftMonth gives the first of the month', () => {
  assert.equal(shiftMonth('2026-10-20', 1), '2026-11-01');
  assert.equal(shiftMonth('2026-01-31', -1), '2025-12-01');
  assert.equal(shiftMonth('2026-01-31', 1), '2026-02-01');
});
test('monthGrid leads with blanks up to Monday', () => {
  const g = monthGrid('2026-10-20');           // 1 Oct 2026 is a Thursday
  assert.equal(g.lead, 3);
  assert.equal(g.days.length, 31);
  assert.equal(g.days[0], '2026-10-01');
  assert.equal(monthGrid('2026-02-10').days.length, 28);
});

test('logDone adds an entry per completion, so a repeating to-do counts every time', () => {
  let log = logDone([], { id:'t1', t:'Water plants' }, '2026-10-20');
  log = logDone(log, { id:'t1', t:'Water plants' }, '2026-10-22');
  assert.deepEqual(log, [{ id:'t1', t:'Water plants', d:'2026-10-20' }, { id:'t1', t:'Water plants', d:'2026-10-22' }]);
});
test('unlogDone removes only the latest entry of that to-do', () => {
  const log = [{ id:'a', t:'A', d:'2026-10-20' }, { id:'b', t:'B', d:'2026-10-21' }, { id:'a', t:'A', d:'2026-10-22' }];
  assert.deepEqual(unlogDone(log, 'a').map(x => x.d), ['2026-10-20', '2026-10-21']);
  assert.deepEqual(unlogDone(log, 'zzz'), log);
});
test('the log keeps 90 days, like the History records', () => {
  const today = '2026-10-22', old = addDays(today, -(LOG_DAYS + 1)), edge = addDays(today, -LOG_DAYS);
  const out = pruneLog([{ id:'x', t:'X', d:old }, { id:'y', t:'Y', d:edge }, { id:'z', t:'Z', d:today }, null, { id:'w' }], today);
  assert.deepEqual(out.map(x => x.id), ['y', 'z']);
});
test('logByDay groups by day and ignores other days', () => {
  const log = [{ id:'a', t:'A', d:'2026-10-20' }, { id:'b', t:'B', d:'2026-10-20' }, { id:'c', t:'C', d:'2026-09-01' }];
  const by = logByDay(log, ['2026-10-20', '2026-10-21']);
  assert.deepEqual(Object.keys(by), ['2026-10-20']); assert.equal(by['2026-10-20'].length, 2);
});
test('the log helpers survive missing or damaged data', () => {
  assert.deepEqual(logDone(undefined, { id:'a', t:'A' }, '2026-10-22'), [{ id:'a', t:'A', d:'2026-10-22' }]);
  assert.deepEqual(unlogDone(null, 'a'), []);
  assert.deepEqual(logByDay('nope', ['2026-10-22']), {});
});
