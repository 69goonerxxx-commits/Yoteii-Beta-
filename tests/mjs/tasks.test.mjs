// Tests for task lookup and removal. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameId, matchTask, normalizeIds, removeTask, removeFromRecord } from '../../src/js/tasks.js';

test('ids compare as text, empty ids never match', () => {
  assert.equal(sameId(101, '101'), true);
  assert.equal(sameId('a', 'a'), true);
  assert.equal(sameId(undefined, undefined), false);
  assert.equal(sameId('', ''), false);
  assert.equal(sameId(null, 'x'), false);
});
test('matchTask uses ids when present and title + window when not', () => {
  assert.equal(matchTask({ id: 5, t: 'A' }, { id: '5' }), true);
  assert.equal(matchTask({ id: 'a', t: 'A' }, { id: 'b', t: 'A' }), false);
  assert.equal(matchTask({ t: 'Walk', w: 'peak' }, { id: 'undefined', t: 'Walk', w: 'peak' }), true);
  assert.equal(matchTask({ t: 'Walk', w: 'peak' }, { t: 'Walk', w: 'climb1' }), false);
  assert.equal(matchTask(null, { id: 'a' }), false);
});
test('normalizeIds fixes missing, numeric and duplicate ids and leaves good data alone', () => {
  let k = 0; const mk = () => 'n' + (k++);
  const input = { home: [{ id: 'a', t: 'ok' }, { t: 'no id' }, { id: 7, t: 'numeric' }, { id: 'a', t: 'dup' }], night: [{ id: 'a', t: 'same id in another list is allowed' }], junk: 'x' };
  const snap = JSON.stringify(input);
  const { blocks, changed } = normalizeIds(input, mk);
  assert.equal(JSON.stringify(input), snap);                       // input untouched
  assert.equal(changed, true);
  assert.deepEqual(blocks.home.map(x => x.id), ['a', 'n0', '7', 'n1']);
  assert.equal(blocks.night[0].id, 'a');
  assert.equal(blocks.junk, 'x');
  assert.equal(normalizeIds(blocks, mk).changed, false);           // already tidy: no change
});
test('removeTask removes from its own list, even for a numeric id', () => {
  const b = { home: [{ id: 101, t: 'A' }, { id: 'b', t: 'B' }], school: [{ id: 'b', t: 'B (school copy)' }] };
  const r = removeTask(b, { l: 'home', id: '101' });
  assert.equal(r.list, 'home'); assert.deepEqual(r.blocks.home.map(x => x.t), ['B']); assert.equal(r.blocks.school.length, 1);
});
test('removeTask only touches the tapped list when the id exists in several lists', () => {
  const b = { home: [{ id: 'b', t: 'B' }], school: [{ id: 'b', t: 'B' }] };
  const r = removeTask(b, { l: 'home', id: 'b' });
  assert.deepEqual([r.blocks.home.length, r.blocks.school.length], [0, 1]);
});
test('removeTask finds a task filed in a different list than expected', () => {
  const b = { home: [], school: [{ id: 'x', t: 'X' }] };
  const r = removeTask(b, { l: 'home', id: 'x' });
  assert.equal(r.list, 'school'); assert.equal(r.blocks.school.length, 0);
});
test('removeTask on a task that does not exist changes nothing and does not throw', () => {
  const b = { home: [{ id: 'a', t: 'A' }] };
  const r = removeTask(b, { l: 'home', id: 'gone' });
  assert.equal(r.list, null); assert.equal(r.blocks, b);
  assert.doesNotThrow(() => removeTask({}, { l: 'nope', id: undefined }));
});
test('removeFromRecord removes the tapped row from a past day, and tolerates bad records', () => {
  const rec = { rows: [{ id: 'a', t: 'A' }, { id: 'b', t: 'B' }] };
  assert.deepEqual(removeFromRecord(rec, { id: 'a' }).rows.map(r => r.id), ['b']);
  assert.equal(removeFromRecord(rec, { id: 'zzz' }), rec);
  assert.equal(removeFromRecord(undefined, { id: 'a' }), undefined);
  assert.deepEqual(removeFromRecord({ rows: [{ t: 'Old task', w: 'peak' }] }, { id: 'undefined', t: 'Old task', w: 'peak' }).rows, []);
});
