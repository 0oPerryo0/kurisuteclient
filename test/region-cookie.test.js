const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDmmGamePage, withRegionCookie, syncRegionCookie, removeRegionCookie } = require('../src/region-cookie');

// Mimics Electron's cookies.get({ name }) filter.
const byName = (items) => async ({ name }) => items.filter((cookie) => cookie.name === name);

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

test('replaces only the region flags in the outgoing Cookie header', () => {
  assert.equal(withRegionCookie('sid=abc; ckcy_remedied_check=ktkrt_argt; ckcy=2; theme=dark'),
    'ckcy_remedied_check=ec_mrnhbtk; ckcy=1; sid=abc; theme=dark');
  assert.equal(withRegionCookie('CKCY_REMEDIED_CHECK=old; ckcy_remedied_check=other; ckcy=0; ckcyx=5'),
    'ckcy_remedied_check=ec_mrnhbtk; ckcy=1; ckcyx=5');
  assert.equal(withRegionCookie(), 'ckcy_remedied_check=ec_mrnhbtk; ckcy=1');
});

test('updates the stored DMM region cookies without changing unrelated cookies', async () => {
  const items = [
    { name: 'ckcy_remedied_check', value: 'ktkrt_argt', domain: '.dmm.co.jp', path: '/',
      secure: true, httpOnly: false, sameSite: 'unspecified', session: true },
    { name: 'ckcy', value: '2', domain: 'dmm.co.jp', path: '/', secure: false,
      httpOnly: false, sameSite: 'unspecified', session: false, expirationDate: 1825000000 },
    { name: 'ckcy_remedied_check', value: 'other', domain: '.notdmm.co.jp', path: '/', session: true },
    { name: 'ckcy', value: '2', domain: '.dmm.com', path: '/', session: true },
  ];
  const calls = [];
  const cookies = {
    get: byName(items),
    set: async (details) => {
      calls.push(details);
      items.find((cookie) => cookie.name === details.name && cookie.domain === details.domain).value = details.value;
    },
    remove: async (url, name) => calls.push({ url, name }),
  };
  await syncRegionCookie(cookies);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ name, domain, value }) => [name, domain, value]),
    [['ckcy_remedied_check', '.dmm.co.jp', 'ec_mrnhbtk'], ['ckcy', 'dmm.co.jp', '1']]);
  assert.equal(calls[0].expirationDate, undefined);
  assert.equal(calls[1].expirationDate, 1825000000);
  assert.equal(items[2].value, 'other');
  assert.equal(items[3].value, '2', '.dmm.com is left alone');
  await syncRegionCookie(cookies);
  assert.equal(calls.length, 2, 'already-correct cookies should not be rewritten');
  await removeRegionCookie(cookies);
  assert.deepEqual(calls.slice(2), [
    { url: 'https://dmm.co.jp/', name: 'ckcy_remedied_check' },
    { url: 'https://dmm.co.jp/', name: 'ckcy' },
  ]);
});

test('creates shared .dmm.co.jp cookies when none exist', async () => {
  const created = [];
  await syncRegionCookie({ get: async () => [], set: async (details) => { created.push(details); } });
  assert.deepEqual(created.map(({ name, domain, path, value }) => [name, domain, path, value]), [
    ['ckcy_remedied_check', '.dmm.co.jp', '/', 'ec_mrnhbtk'],
    ['ckcy', '.dmm.co.jp', '/', '1'],
  ]);
});

test('creates a shared cookie even when a host-only region cookie exists', async () => {
  const calls = [];
  await syncRegionCookie({
    get: byName([{ name: 'ckcy_remedied_check', value: 'ktkrt_argt',
      domain: 'special.dmm.co.jp', path: '/', session: true },
    { name: 'ckcy', value: '1', domain: '.dmm.co.jp', path: '/', session: true }]),
    set: async (details) => { calls.push(details); },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].domain, '.dmm.co.jp');
  assert.equal(calls[1].domain, 'special.dmm.co.jp');
});

test('recognises only our override values as already applied', () => {
  const { isRegionValue } = require('../src/region-cookie');
  assert.equal(isRegionValue({ name: 'ckcy', value: '1' }), true);
  assert.equal(isRegionValue({ name: 'ckcy', value: '2' }), false);
  assert.equal(isRegionValue({ name: 'ckcy_remedied_check', value: 'ec_mrnhbtk' }), true);
  assert.equal(isRegionValue({ name: 'constructor', value: undefined }), false);
});

test('replaces a Simplified Chinese first language that DMM sends to the region gate', () => {
  const { gameAcceptLanguages } = require('../src/region-cookie');
  for (const locale of ['zh-CN', 'zh', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'ZH-cn'])
    assert.equal(gameAcceptLanguages(locale), 'ja-JP,ja,en-US,en', locale);
  for (const locale of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW', 'ja', 'en-US', '', undefined])
    assert.equal(gameAcceptLanguages(locale), null, String(locale));
});
