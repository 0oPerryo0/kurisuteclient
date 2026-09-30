const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { guessScript, OBJECTS, METHODS } = require('../src/unity-guesses');

test('Unity probes send only 1× to an approved candidate', () => {
  const calls = [];
  const page = { unityInstance: { SendMessage: (...args) => calls.push(args) } };
  page.window = page;
  assert.equal(vm.runInNewContext(guessScript(OBJECTS[0], METHODS[0]), page), true);
  assert.deepEqual(calls, [[OBJECTS[0], METHODS[0], 1]]);
});

test('unknown Unity probe targets are rejected', () => {
  assert.throws(() => guessScript('UnknownObject', 'SetSpeed'));
});
