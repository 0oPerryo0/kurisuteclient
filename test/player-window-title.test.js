const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DEFAULT_WINDOW_TITLE, UPDATE_NOTICE, playerWindowTitle, attachPlayerWindowTitle } = require('../src/player-window-title');

test('local title preserves the original title and formats only known player values', () => {
  assert.equal(playerWindowTitle('Original', null), 'Original');
  assert.equal(playerWindowTitle('Original', { nickname: 'Perry', level: 96, stamina: 279, staminaMax: 180 }),
    'Original | Perry Level: 96 Stam: 279');
  assert.equal(playerWindowTitle('Original', { nickname: 'Perry', level: 96, stamina: 0 }),
    'Original | Perry Level: 96 Stam: 0');
  assert.equal(playerWindowTitle('Original', { level: NaN, stamina: -1, staminaMax: Infinity }),
    'Original | Player Level: ? Stam: ?');
});

test('title sanitizes nickname controls and labels retained samples without guessing regeneration', () => {
  const title = playerWindowTitle('Original', { nickname: '  P\nerr\u202ey  ', level: 96, stamina: 279,
    staminaLastRead: true, staminaAgeMinutes: 3 });
  assert.equal(title, 'Original | Perry Level: 96 Stam: 279 (last read 3m ago)');
  assert.match(playerWindowTitle('Original', { level: 96, stamina: 279, lastKnown: true }), /\(last known\)$/);
  const long = playerWindowTitle('Original', { nickname: '😀'.repeat(80), level: 1, stamina: 1 });
  assert.equal([...long.match(/\| (.+) Level:/)[1]].length, 48);
});

test('title controller survives shell title updates and restores the original on privacy/lifecycle clears', () => {
  const window = { webContents: new EventEmitter(), destroyed: false, title: '',
    isDestroyed() { return this.destroyed; }, setTitle(title) { this.title = title; } };
  const controller = attachPlayerWindowTitle(window);
  assert.equal(window.title, DEFAULT_WINDOW_TITLE);
  controller.setPlayer({ nickname: 'PRIVATE_NAME', level: 42, stamina: 120 });
  let prevented = false;
  window.webContents.emit('page-title-updated', { preventDefault() { prevented = true; } }, 'Original');
  assert.equal(prevented, true);
  assert.equal(window.title, 'Original | PRIVATE_NAME Level: 42 Stam: 120');
  controller.setUpdateNotice(UPDATE_NOTICE);
  assert.equal(window.title, 'Original | PRIVATE_NAME Level: 42 Stam: 120 | New update is available');
  controller.setPlayer(null);
  assert.equal(window.title, 'Original | New update is available', 'The notice does not depend on player data');
  controller.setUpdateNotice(null);
  assert.equal(window.title, 'Original');
  window.destroyed = true;
  assert.doesNotThrow(() => controller.setPlayer(null));
});

test('update notice is appended with the same | separator', () => {
  assert.equal(UPDATE_NOTICE, 'New update is available');
  assert.equal(playerWindowTitle('Original', null, UPDATE_NOTICE), 'Original | New update is available');
  assert.equal(playerWindowTitle('Original', null, 'Downloading update 42%'), 'Original | Downloading update 42%');
  assert.equal(playerWindowTitle('Original', { nickname: 'Perry', level: 96, stamina: 279, staminaLastRead: true, staminaAgeMinutes: 3 }, UPDATE_NOTICE),
    'Original | Perry Level: 96 Stam: 279 (last read 3m ago) | New update is available');
});
