const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { SPEED_OPTIONS, selectSpeed, createClock, gameClockScript } = require('../src/game-clock');

test('2× clock doubles elapsed time and does not jump when changed', () => {
  let real = 1000;
  const clock = createClock(() => real);
  real = 1100;
  assert.equal(clock.setSpeed(2), true);
  real = 1200;
  assert.equal(clock.now(), 1300);
  assert.equal(clock.setSpeed(1), true);
  real = 1500;
  assert.equal(clock.now(), 1600);
});

test('game clock script is valid, starts at the selected speed, and ignores other hosts', () => {
  const source = gameClockScript(2);
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /speed: 2/);
  assert.match(source, /games\.mofushippo\.com/);
  assert.equal(source.includes('Date.now'), false);
});

test('99× is selectable only by Ctrl plus the normal 10× option', () => {
  assert.deepEqual(SPEED_OPTIONS, [1, 2, 3, 5, 10]);
  assert.equal(selectSpeed(10, { ctrlKey: true }), 99);
  assert.equal(selectSpeed(10), 10);
  assert.equal(selectSpeed(10, { ctrlKey: false }), 10);
  assert.equal(selectSpeed(10, { shiftKey: true, altKey: true, metaKey: true }), 10);
  for (const speed of [1, 2, 3, 5]) assert.equal(selectSpeed(speed, { ctrlKey: true }), speed);
  assert.throws(() => selectSpeed(99), /Invalid speed/);
  assert.throws(() => selectSpeed(99, { ctrlKey: true }), /Invalid speed/);
});

test('99× clock advances at the selected rate and returns to 10× without a jump', () => {
  let real = 1000;
  const clock = createClock(() => real);
  assert.equal(clock.setSpeed(selectSpeed(10, { ctrlKey: true })), true);
  real += 10;
  assert.equal(clock.now(), 1990);
  assert.equal(clock.setSpeed(selectSpeed(10)), true);
  assert.equal(clock.now(), 1990);
  real += 10;
  assert.equal(clock.now(), 2090);
  assert.equal(clock.setSpeed(100), false);
});

test('injected game clock accepts 99× initially and when switched at runtime', () => {
  let real = 1000;
  class Performance { now() { return real; } }
  const window = {};
  const context = { window, location: { hostname: 'games.mofushippo.com' },
    performance: new Performance(), Performance };
  vm.runInNewContext(gameClockScript(99), context);
  assert.equal(window.__cristeClock.speed(), 99);
  real += 10;
  assert.equal(context.performance.now(), 1990);
  assert.equal(window.__cristeClock.setSpeed(10), true);
  assert.equal(context.performance.now(), 1990);
  real += 10;
  assert.equal(context.performance.now(), 2090);
  assert.equal(window.__cristeClock.setSpeed(99), true);
  real += 10;
  assert.equal(context.performance.now(), 3080);
});
