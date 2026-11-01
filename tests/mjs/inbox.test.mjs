import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOf, daysAgo, addedLabel, sortList, groups, stats, applyOrder, makeTask, insertNew, normalizePrefs } from '../../src/js/inbox.js';

const NOW = new Date(2026, 9, 20, 9, 30).getTime(), at = d => new Date(2026, 9, 20 - d, 8).getTime();
const T = (id, t, o = {}) => ({ id, t, ...o });

test('stampOf reads at, then the time inside an old id, else 0', () => {
  assert.equal(stampOf({ id:'x', at:123 }), 123);
  assert.equal(stampOf({ id:'i' + at(3).toString(36) }), at(3));
  assert.equal(stampOf({ id:'i1' }), 0);
  assert.equal(stampOf({ id:'inope!' }), 0);
  assert.equal(stampOf({}), 0);
});
test('addedLabel: today, yesterday, days ago, then a date', () => {
  assert.equal(addedLabel({ id:'a', at:at(0) }, NOW), 'Added today');
  assert.equal(addedLabel({ id:'a', at:at(1) }, NOW), 'Added yesterday');
  assert.equal(addedLabel({ id:'a', at:at(5) }, NOW), 'Added 5 days ago');
  assert.equal(addedLabel({ id:'a', at:at(9) }, NOW, 'en-US'), 'Added Oct 11');
  assert.equal(addedLabel({ id:'a', at:new Date(2025, 11, 30, 8).getTime() }, NOW, 'en-US'), 'Added Dec 30, 2025');
  assert.equal(addedLabel({ id:'a' }, NOW), '');
  assert.equal(daysAgo({ id:'a', at:NOW + 5 * 864e5 }, NOW), 0);            // never negative
});
test('sortList: manual keeps order, others sort, nothing is changed in place', () => {
  const l = [T('a', 'Banana', { at:at(2) }), T('b', 'apple', { at:at(5) }), T('c', 'Cherry', { at:at(0) })], copy = l.map(x => x.id);
  assert.deepEqual(sortList(l, 'manual').map(x => x.id), ['a', 'b', 'c']);
  assert.deepEqual(sortList(l, 'new').map(x => x.id), ['c', 'a', 'b']);
  assert.deepEqual(sortList(l, 'old').map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(sortList(l, 'az').map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(l.map(x => x.id), copy);
});
test('groups put important first and sort inside each group', () => {
  const l = [T('a', 'A', { at:at(1) }), T('b', 'B', { imp:true, at:at(4) }), T('c', 'C', { at:at(3) }), T('d', 'D', { imp:true, at:at(2) })];
  const g = groups(l, 'old');
  assert.deepEqual(g.imp.map(x => x.id), ['b', 'd']);
  assert.deepEqual(g.rest.map(x => x.id), ['c', 'a']);
});
test('stats: waiting, important, oldest in days', () => {
  assert.deepEqual(stats([], NOW), { total:0, imp:0, oldest:null });
  assert.deepEqual(stats([T('a', 'A', { at:at(9) }), T('b', 'B', { imp:true, at:at(0) }), T('c', 'C')], NOW), { total:3, imp:1, oldest:9 });
});
test('applyOrder moves one group and keeps the other', () => {
  const l = [T('a', 'A'), T('b', 'B', { imp:true }), T('c', 'C'), T('d', 'D', { imp:true }), T('e', 'E')];
  assert.deepEqual(applyOrder(l, 'manual', 'rest', ['e', 'a', 'c']).map(x => x.id), ['b', 'd', 'e', 'a', 'c']);
  assert.deepEqual(applyOrder(l, 'manual', 'imp', ['d', 'b']).map(x => x.id), ['d', 'b', 'a', 'c', 'e']);
  assert.deepEqual(applyOrder(l, 'manual', 'rest', ['c']).map(x => x.id), ['b', 'd', 'c', 'a', 'e']);   // ids that were missed are kept
  assert.deepEqual(applyOrder(l, 'manual', 'rest', ['zz', 'c']).map(x => x.id), ['b', 'd', 'c', 'a', 'e']); // unknown ids are ignored
});
test('a drag while sorted newest-first keeps what was on screen', () => {
  const l = [T('a', 'A', { at:at(5) }), T('b', 'B', { at:at(1) }), T('c', 'C', { at:at(3) })];         // on screen: b, c, a
  assert.deepEqual(applyOrder(l, 'new', 'rest', ['c', 'b', 'a']).map(x => x.id), ['c', 'b', 'a']);
});
test('makeTask and insertNew', () => {
  const x = makeTask('  Call  ', { note:'  hi ', imp:true }, NOW);
  assert.deepEqual(x, { id:'i' + NOW.toString(36), t:'Call', at:NOW, note:'hi', imp:true });
  assert.equal(stampOf(x), NOW);
  assert.deepEqual(makeTask('x', { note:'   ' }, NOW), { id:'i' + NOW.toString(36), t:'x', at:NOW });
  assert.equal(makeTask('x', { note:'y'.repeat(500) }, NOW).note.length, 300);
  assert.deepEqual(insertNew([T('a', 'A')], T('b', 'B')).map(x => x.id), ['b', 'a']);
});
test('normalizePrefs falls back to All and Manual', () => {
  assert.deepEqual(normalizePrefs(null), { f:'all', s:'manual' });
  assert.deepEqual(normalizePrefs({ f:'imp', s:'az' }), { f:'imp', s:'az' });
  assert.deepEqual(normalizePrefs({ f:'x', s:'nope' }), { f:'all', s:'manual' });
});
