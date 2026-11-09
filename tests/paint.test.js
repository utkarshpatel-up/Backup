'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, setHtml } = require('../renderer/paint.js');

test('nothing changed: nothing to do', () => {
  assert.deepEqual(plan({ a: 'x', rows: ['1', '2'] }, { a: 'x', rows: ['1', '2'] }), []);
});
test('a changed region and a changed row come out alone', () => {
  assert.deepEqual(plan({ a: 'x', rows: ['1', '2', '3'] }, { a: 'y', rows: ['1', '9', '3'] }),
    [{ name: 'a', html: 'y' }, { name: 'rows', rows: [[1, '9']] }]);
});
test('a structural change or a different set of regions asks for a full paint', () => {
  assert.equal(plan({ a: 'x' }, { a: 'y' }, ['a']), null);
  assert.equal(plan({ a: 'x' }, { b: 'x' }), null);
  assert.equal(plan({ a: 'x' }, { a: 'x', b: 'y' }), null);
  assert.equal(plan({ a: 'x' }, { a: ['x'] }), null);
});
test('rows only added are appended; otherwise a resized list is replaced', () => {
  assert.deepEqual(plan({ r: ['1'] }, { r: ['1', '2', '3'] }), [{ name: 'r', append: ['2', '3'] }]);
  assert.deepEqual(plan({ r: ['1', '2'] }, { r: ['1'] }), [{ name: 'r', all: '1' }]);
  assert.deepEqual(plan({ r: ['1', '2'] }, { r: ['9', '2', '3'] }), [{ name: 'r', all: '923' }]);
});
test('when most rows change the whole list is cheaper', () => {
  assert.deepEqual(plan({ r: ['1', '2', '3'] }, { r: ['7', '8', '3'] }), [{ name: 'r', all: '783' }]);
});
test('a forced row repaints though its HTML is the same', () => {
  assert.deepEqual(plan({ r: ['1', '2', '3'] }, { r: ['1', '2', '3'] }, [], [1]), [{ name: 'r', rows: [[1, '2']] }]);
});
test('setHtml writes only a change', () => {
  const el = { lastHtml: undefined, innerHTML: '' };
  assert.equal(setHtml(el, 'a'), true); assert.equal(el.innerHTML, 'a');
  el.innerHTML = 'kept'; assert.equal(setHtml(el, 'a'), false); assert.equal(el.innerHTML, 'kept');
});
