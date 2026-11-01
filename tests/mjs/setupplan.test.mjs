import test from 'node:test';
import assert from 'node:assert/strict';
import { planTypes, ownNameError, sleepRangeFor } from '../../src/js/setupplan.js';

test('picking nothing leaves the defaults alone', () => {
  const p = planTypes([]);
  assert.deepEqual(p.slotNames, {}); assert.equal(p.main, null); assert.deepEqual(p.names, ['Home', 'School', 'Away']);
});
test('Work takes the second slot and Away stays', () => {
  const p = planTypes([{ kind:'work' }]);
  assert.deepEqual(p.slotNames, { school:'Work' }); assert.equal(p.main, 'school'); assert.deepEqual(p.names, ['Home', 'Work', 'Away']);
});
test('School alone changes nothing but is still the day you head out', () => {
  const p = planTypes([{ kind:'school' }]);
  assert.deepEqual(p.slotNames, {}); assert.equal(p.main, 'school'); assert.deepEqual(p.names, ['Home', 'School', 'Away']);
});
test('Work and Sick fill both slots, so Away makes room', () => {
  const p = planTypes([{ kind:'work' }, { kind:'sick' }]);
  assert.deepEqual(p.slotNames, { school:'Work', away:'Sick' }); assert.deepEqual(p.names, ['Home', 'Work', 'Sick']);
});
test('School and Sick keep School in the second slot', () => {
  const p = planTypes([{ kind:'sick' }, { kind:'school' }]);
  assert.deepEqual(p.slotNames, { away:'Sick' }); assert.deepEqual(p.names, ['Home', 'School', 'Sick']);
});
test('Sick alone takes the second slot and Away stays', () => {
  const p = planTypes([{ kind:'sick' }]);
  assert.deepEqual(p.slotNames, { school:'Sick' }); assert.equal(p.main, null); assert.deepEqual(p.names, ['Home', 'Sick', 'Away']);
});
test('your own type replaces Away when Work is also picked, and keeps its icon', () => {
  const p = planTypes([{ kind:'work' }, { kind:'own', name:' Night  shift ', icon:'moon' }]);
  assert.deepEqual(p.slotNames, { school:'Work', away:'Night shift' }); assert.deepEqual(p.icons, { 'Night shift':'moon' });
  assert.deepEqual(p.names, ['Home', 'Work', 'Night shift']);
});
test('two of your own picks without Work or School fill the slots in the order ticked', () => {
  const p = planTypes([{ kind:'own', name:'Travel', icon:'airplane' }, { kind:'sick' }]);
  assert.deepEqual(p.slotNames, { school:'Travel', away:'Sick' }); assert.equal(p.main, null);
});
test('your own type with no icon gets a star', () => {
  assert.deepEqual(planTypes([{ kind:'own', name:'Travel' }]).icons, { Travel:'star' });
});
test('more than two picks, or Work with School, are refused', () => {
  assert.ok(planTypes([{ kind:'work' }, { kind:'sick' }, { kind:'own', name:'Gym' }]).error);
  assert.ok(planTypes([{ kind:'work' }, { kind:'school' }]).error);
});
test('repeats and unknown picks are ignored', () => {
  const p = planTypes([{ kind:'work' }, { kind:'work' }, { kind:'nope' }, null]);
  assert.deepEqual(p.names, ['Home', 'Work', 'Away']);
});
test('names for your own day type are checked', () => {
  assert.equal(ownNameError('Night shift'), '');
  assert.match(ownNameError('   '), /name/i);
  assert.match(ownNameError('A really long name here'), /14/);
  for (const n of ['home', 'WORK', 'School', 'sick', 'Away']) assert.match(ownNameError(n), /already/);
  assert.ok(planTypes([{ kind:'own', name:'Home' }]).error);
});
test('typical sleep ranges follow age', () => {
  assert.equal(sleepRangeFor(0), null); assert.equal(sleepRangeFor(NaN), null); assert.equal(sleepRangeFor(undefined), null);
  assert.deepEqual(sleepRangeFor(1), [11, 14]); assert.deepEqual(sleepRangeFor(4), [10, 13]); assert.deepEqual(sleepRangeFor(9), [9, 12]);
  assert.deepEqual(sleepRangeFor(15), [8, 10]); assert.deepEqual(sleepRangeFor(24), [7, 9]); assert.deepEqual(sleepRangeFor(70), [7, 8]);
});
