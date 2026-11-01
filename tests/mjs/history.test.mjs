// Tests for the History tab maths: streak with a grace day, ranges, day stats. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { streaks, rangeFor, dayStat, unlocks } from '../../src/js/history.js';

const T = '2026-10-22';   // a Thursday
const P = o => o;        // day -> completion 0..1

test('streak counts consecutive hit days (70% or more)', () => {
  const s = streaks(P({ '2026-10-19': .8, '2026-10-20': .9, '2026-10-21': .7 }), T);
  assert.deepEqual([s.cur, s.best, s.graces, s.pending], [3, 3, 0, false]);
});
test('one missed day does not break the streak, and is reported as a grace day', () => {
  const s = streaks(P({ '2026-10-18': .9, '2026-10-19': .9, '2026-10-20': .2, '2026-10-21': .9, '2026-10-22': .9 }), T);
  assert.deepEqual([s.cur, s.graces, s.pending], [4, 1, false]);
});
test('two missed days in a row reset the streak, the best is kept', () => {
  const s = streaks(P({ '2026-10-16': .9, '2026-10-17': .9, '2026-10-18': .9, '2026-10-19': .1, '2026-10-20': .1, '2026-10-21': .9 }), T);
  assert.deepEqual([s.cur, s.best], [1, 3]);
});
test('a day with no record counts as a miss', () => {
  const s = streaks(P({ '2026-10-17': .9, '2026-10-18': .9, '2026-10-21': .9 }), T);   // 19 and 20 missing
  assert.deepEqual([s.cur, s.best], [1, 2]);
});
test('yesterday missed: streak is kept but marked pending until today is finished', () => {
  const s = streaks(P({ '2026-10-19': .9, '2026-10-20': .9, '2026-10-21': .1 }), T);
  assert.deepEqual([s.cur, s.pending], [2, true]);
});
test('today in progress never counts as a miss', () => {
  const s = streaks(P({ '2026-10-20': .9, '2026-10-21': .9, '2026-10-22': .2 }), T);
  assert.deepEqual([s.cur, s.pending], [2, false]);
});
test('no records gives zeros', () => {
  assert.deepEqual(streaks({}, T), { cur: 0, best: 0, graces: 0, pending: false, next: 0 });
});
test('week range starts on Monday and stops at today', () => {
  const R = rangeFor('week', 0, T, '2026-09-28');
  assert.deepEqual([R.start, R.end, R.days.length, R.title, R.canPrev, R.canNext], ['2026-10-19', '2026-10-25', 4, 'This week', true, false]);
  const L = rangeFor('week', -1, T, '2026-09-28');
  assert.deepEqual([L.start, L.end, L.days.length, L.title, L.canNext], ['2026-10-12', '2026-10-18', 7, 'Last week', true]);
});
test('previous is disabled once the range reaches the first record', () => {
  assert.equal(rangeFor('week', -3, T, '2026-09-28').canPrev, false);   // week of Sep 28 contains the first record
  assert.equal(rangeFor('month', 0, T, '2026-10-05').canPrev, false);
});
test('month and all ranges', () => {
  const M = rangeFor('month', -1, T, '2026-01-01');
  assert.deepEqual([M.start, M.end, M.days.length], ['2026-09-01', '2026-09-30', 30]);
  const A = rangeFor('all', 5, T, '2026-10-01');
  assert.deepEqual([A.start, A.end, A.off, A.days.length, A.canPrev, A.canNext], ['2026-10-01', T, 0, 22, false, false]);
});
test('dayStat ignores suggestions and zero-length rows', () => {
  const s = dayStat({ rows: [{ u: 10, done: true }, { u: 10, done: false }, { u: 0, done: true }, { u: 10, sug: true, done: true }] });
  assert.deepEqual([s.planned, s.done, s.pct], [2, 1, .5]);
  assert.equal(dayStat(undefined).pct, null);
});
test('unlocks report progress toward each locked card', () => {
  const S = { tracked: [{}, {}], win: { peak: { d: 3, t: 6 } } };
  const L = unlocks({}, S, { names: { peak: 'Peak', trough: 'Trough' }, energy: [] });
  assert.deepEqual(L.map(x => [x.t, x.n, x.of]), [['Review', 2, 3], ['Energy by window', 1, 2]]);
});

test('a second miss within 7 days of a grace day ends the streak', () => {
  const s = streaks(P({ '2026-10-12': .9, '2026-10-13': .9, '2026-10-14': .2, '2026-10-15': .9, '2026-10-16': .2,
    '2026-10-17': .9, '2026-10-18': .9, '2026-10-19': .9, '2026-10-20': .9, '2026-10-21': .9 }), T);
  assert.deepEqual([s.cur, s.best, s.graces], [5, 5, 0]);
});
test('a grace day comes back after 7 hit days', () => {
  const d = n => '2026-10-' + String(n).padStart(2, '0'), o = {};
  [1, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].forEach(n => { o[d(n)] = .9; }); o[d(2)] = .2; o[d(11)] = .2;
  const s = streaks(P(o), T);
  assert.deepEqual([s.cur, s.graces], [19, 2]);
});
test('reports how many days until the next grace day', () => {
  assert.equal(streaks(P({ '2026-10-19': .9, '2026-10-20': .2, '2026-10-21': .9 }), T).next, 7);
  assert.equal(streaks(P({ '2026-10-19': .9, '2026-10-20': .2, '2026-10-21': .9, '2026-10-22': .9 }), T).next, 6);
});
