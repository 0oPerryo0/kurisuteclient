const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClock, gameClockScript } = require('../src/game-clock');

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
