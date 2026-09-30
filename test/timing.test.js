const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { fpsScript } = require('../src/fps-script');

function clock() {
  let next = 1;
  const callbacks = new Map();
  const page = {
    requestAnimationFrame(callback) { const id = next++; callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
  };
  page.window = page;
  return {
    page,
    inject: (cap) => vm.runInNewContext(fpsScript(cap), page),
    advance(timestamp) {
      const current = [...callbacks.values()];
      callbacks.clear();
      current.forEach((callback) => callback(timestamp));
    },
  };
}

test('default settings leave requestAnimationFrame untouched', () => {
  const game = clock();
  const native = game.page.requestAnimationFrame;
  game.inject(0);
  assert.equal(game.page.requestAnimationFrame, native);
});

test('FPS cap preserves the native callback timestamp', () => {
  const game = clock();
  const times = [];
  game.inject(30);
  const request = () => game.page.requestAnimationFrame((time) => { times.push(time); request(); });
  request();
  for (const time of [0, 17, 34, 51, 68]) game.advance(time);
  assert.deepEqual(times, [0, 34, 68]);
});

test('removing the FPS cap resumes native callback cadence', () => {
  const game = clock();
  const times = [];
  game.inject(30);
  const request = () => game.page.requestAnimationFrame((time) => { times.push(time); request(); });
  request();
  game.advance(0);
  game.inject(0);
  game.advance(17);
  game.advance(34);
  assert.deepEqual(times, [0, 17, 34]);
});
