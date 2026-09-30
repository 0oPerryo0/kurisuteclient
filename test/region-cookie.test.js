const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDmmGamePage, withRegionCookie, syncRegionCookie, removeRegionCookie } = require('../src/region-cookie');

test('restricts the override to HTTPS dmm.co.jp region gate and game pages', () => {
  for (const url of ['https://games.dmm.co.jp/detail/charsapple_x_879635',
    'https://games.dmm.co.jp/top/zh-CHT', 'https://play.games.dmm.co.jp/game/123',
    'https://special.dmm.co.jp/not-available-in-your-region/',
    'https://www.dmm.co.jp/netgame']) assert.equal(isDmmGamePage(url), true, url);
  for (const url of ['https://evil-dmm.co.jp/netgame/', 'https://dmm.co.jp.evil.com/netgame',
    'http://games.dmm.co.jp/detail/charsapple_x_879635',
    'https://accounts.dmm.co.jp/service/login/password',
    'https://special.dmm.co.jp/other', 'https://www.dmm.com/netgame',
    'https://www.dmm.co.jp/']) {
    assert.equal(isDmmGamePage(url), false, url);
  }
});

test('replaces only the region flag in the outgoing Cookie header', () => {
  assert.equal(withRegionCookie('sid=abc; ckcy_remedied_check=ktkrt_argt; theme=dark'),
    'ckcy_remedied_check=ec_mrnhbtk; sid=abc; theme=dark');
  assert.equal(withRegionCookie('CKCY_REMEDIED_CHECK=old; ckcy_remedied_check=other; ckcy=0'),
    'ckcy_remedied_check=ec_mrnhbtk; ckcy=0');
  assert.equal(withRegionCookie(), 'ckcy_remedied_check=ec_mrnhbtk');
});

test('updates the stored DMM region cookie without changing unrelated cookies', async () => {
  const items = [
    { name: 'ckcy_remedied_check', value: 'ktkrt_argt', domain: '.dmm.co.jp', path: '/',
      secure: true, httpOnly: false, sameSite: 'unspecified', session: true },
    { name: 'ckcy_remedied_check', value: 'other', domain: '.notdmm.co.jp', path: '/', session: true },
  ];
  const calls = [];
  const cookies = {
    get: async () => items,
    set: async (details) => { calls.push(details); items[0].value = details.value; },
    remove: async (url, name) => calls.push({ url, name }),
  };
  await syncRegionCookie(cookies);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, '.dmm.co.jp');
  assert.equal(calls[0].value, 'ec_mrnhbtk');
  assert.equal(calls[0].expirationDate, undefined);
  await syncRegionCookie(cookies);
  assert.equal(calls.length, 1, 'already-correct cookie should not be rewritten');
  await removeRegionCookie(cookies);
  assert.deepEqual(calls[1], { url: 'https://dmm.co.jp/', name: 'ckcy_remedied_check' });
});

test('creates a shared .dmm.co.jp cookie when none exists', async () => {
  let created;
  await syncRegionCookie({ get: async () => [], set: async (details) => { created = details; } });
  assert.equal(created.domain, '.dmm.co.jp');
  assert.equal(created.path, '/');
  assert.equal(created.value, 'ec_mrnhbtk');
});

test('creates a shared cookie even when a host-only region cookie exists', async () => {
  const calls = [];
  await syncRegionCookie({
    get: async () => [{ name: 'ckcy_remedied_check', value: 'ktkrt_argt',
      domain: 'special.dmm.co.jp', path: '/', session: true }],
    set: async (details) => { calls.push(details); },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].domain, '.dmm.co.jp');
  assert.equal(calls[1].domain, 'special.dmm.co.jp');
});
