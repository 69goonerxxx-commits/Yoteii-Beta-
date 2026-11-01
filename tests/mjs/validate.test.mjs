// Tests for backup validation. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackup } from '../../src/js/validate.js';

const P = 'yotei_v2_';
const backup = (data, extra = {}) => ({ app: 'yotei', v: 2, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [P + k, typeof v === 'string' && extra.raw ? v : JSON.stringify(v)])), ...extra.top });
const good = {
  blocks: { pre: [{ id: 'a', t: 'Water', d: 10, m: 5, p: 'core' }], night: [] },
  plans: { '2026-10-11': { w: 300, t: { climb1: 'home' }, o: [{ id: 'o1', t: 'Call', d: 15 }], n: 'hi' } },
  hist: { '2026-10-11': { rows: [{ t: 'Water', s: 300, e: 310, u: 10, done: true }], note: 'ok' } },
  ovr: { a: [{ patch: { d: 20 } }] }, inbox: [{ id: 'i1', t: 'Milk' }], taskNotes: {}, usual: { 0: 'home' }, caps: { soft: 1320, hard: 1380 }, clock: '12', setup: true, lastBackup: 1760000000000,
};

// Every shape below is exactly what the app writes (see the store.set calls in main.js).
test('every real kind of stored value is accepted', () => {
  const real = { bkAsk: '2026-10-11', wake: 300, usual: { 1: 'home', 0: 'away' }, caps: { soft: 1320, hard: 1380 }, setup: true, clock: '24', lastBackup: Date.now(), schemaV: 3, dateFmt: 'iso', theme: 'dark', text: 'normal', tab: 'home', rem: { on: true }, energy: [{ v: 3, d: '2026-10-11' }], wins: { peak: { from: 180 } }, wovr: {} };
  Object.entries(real).forEach(([k, v]) => assert.equal(validateBackup(backup({ [k]: v })).ok, true, k));
});
test('older stored shapes are accepted too', () => {
  assert.equal(validateBackup(backup({ wake: { home: 300 }, bkAsk: 'Sat Oct 10 2026' })).ok, true);
});

test('empty (null) fields are tolerated, wrong types are not', () => {
  assert.equal(validateBackup(backup({ blocks: { pre: [{ t: 'x', d: 10, m: null, fixed: null }] } })).ok, true);
  assert.equal(validateBackup(backup({ blocks: { pre: [{ t: 'x', d: 10, m: 'five' }] } })).ok, false);
});

test('a normal backup is accepted', () => assert.equal(validateBackup(backup(good)).ok, true));
test('unknown keys with the right prefix are allowed (forward compatible)', () => assert.equal(validateBackup(backup({ ...good, futureThing: { x: 1 } })).ok, true));
test('not a Yotei file', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({ app: 'other', data: {} }).ok, false);
  assert.match(validateBackup({ app: 'yotei', v: 2, data: {} }).why, /no data/);
});
test('backups from a newer version are refused', () => assert.match(validateBackup(backup(good, { top: { v: 4 } })).why, /newer version/));
test('v3 backups (ISO days) and v2 backups are both accepted', () => {
  assert.equal(validateBackup(backup({ ...good, dateFmt: 'iso' }, { top: { v: 3 } })).ok, true);
  assert.equal(validateBackup(backup(good, { top: { v: 2 } })).ok, true);
  assert.equal(validateBackup(backup({ ...good, dateFmt: 'other' })).ok, false);
});
test('entries outside the yotei_v2_ prefix are refused', () => assert.equal(validateBackup({ app: 'yotei', v: 2, data: { evil: '1' } }).ok, false));
test('damaged JSON inside an entry is named', () => assert.match(validateBackup({ app: 'yotei', v: 2, data: { [P + 'plans']: '{oops' } }).why, /"plans" data is damaged/));
test('wrong types are rejected before they can break the app', () => {
  assert.equal(validateBackup(backup({ blocks: { pre: [{ t: 'x', d: '10' }] } })).ok, false);        // duration as text
  assert.equal(validateBackup(backup({ blocks: [] })).ok, false);                                    // wrong container
  assert.equal(validateBackup(backup({ plans: { d: { t: 'oops' } } })).ok, false);                   // types must be an object
  assert.equal(validateBackup(backup({ plans: { d: { w: 'late' } } })).ok, false);                   // wake must be a number
  assert.equal(validateBackup(backup({ hist: { d: { rows: [{ s: 'x' }] } } })).ok, false);
  assert.equal(validateBackup(backup({ ovr: { a: 'nope' } })).ok, false);
  assert.equal(validateBackup(backup({ inbox: {} })).ok, false);
  assert.equal(validateBackup(backup({ clock: '13' })).ok, false);
  assert.equal(validateBackup(backup({ caps: { soft: 'x' } })).ok, false);
});

test('the finished to-do log is accepted, and a wrong shape is rejected', () => {
  assert.equal(validateBackup(backup({ ...good, todoLog: [{ id: 't1', t: 'Pay the load', d: '2026-10-20' }] })).ok, true);
  assert.equal(validateBackup(backup({ ...good, todoLog: [{ id: 't1', t: 5, d: '2026-10-20' }] })).ok, false);
  assert.equal(validateBackup(backup({ ...good, todoLog: 'nope' })).ok, false);
});
