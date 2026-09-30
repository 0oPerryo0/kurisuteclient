const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GameAssetCache, isGameAsset, cachePolicy, manifestAssets } = require('../src/game-asset-cache');

test('only approved static resources are cache eligible', () => {
  assert.equal(isGameAsset('https://games.mofushippo.com/CryWebAws/Build/game.data.unityweb'), true);
  assert.equal(isGameAsset('https://games.mofushippo.com/assets/a.bundle?v=2'), true);
  for (const url of ['https://accounts.dmm.co.jp/login', 'https://games.mofushippo.com/api/player',
    'https://games.mofushippo.com/a.bundle?token=secret', 'https://evil.games.mofushippo.com/a.bundle',
    'http://games.mofushippo.com/a.bundle']) assert.equal(isGameAsset(url), false, url);
});

test('respects private, no-store, cookies and varying responses', () => {
  for (const headers of [{ 'cache-control': 'private' }, { 'cache-control': 'no-store' },
    { 'set-cookie': 'sid=x' }, { vary: 'Cookie' }]) assert.equal(cachePolicy(new Headers(headers)), null);
  assert.ok(cachePolicy(new Headers({ 'cache-control': 'max-age=600' })).freshUntil <= Date.now() + 300000);
});

test('disk cache serves fresh bodies, revalidates stale bodies and clears', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'criste-assets-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const cache = new GameAssetCache(directory, async (request) => {
    calls++;
    if (request.headers.get('if-none-match') === 'version-1')
      return new Response(null, { status: 304, headers: { 'cache-control': 'max-age=60' } });
    return new Response('unity asset bytes', { headers: { etag: 'version-1',
      'cache-control': 'max-age=60', 'content-type': 'application/octet-stream' } });
  });
  const url = 'https://games.mofushippo.com/assets/a.bundle';
  assert.equal(await (await cache.fetch(url)).text(), 'unity asset bytes');
  await Promise.all([...cache.pending]);
  assert.equal(await (await cache.fetch(url)).text(), 'unity asset bytes');
  assert.equal(calls, 1);
  assert.equal(await (await cache.fetch(new Request(url, { cache: 'reload' }))).text(), 'unity asset bytes');
  assert.equal(calls, 2);
  await cache.clear();
  assert.equal(await cache.read(url), null);
});

test('does not cache HTML errors disguised as bundle files', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'criste-assets-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const cache = new GameAssetCache(directory, async () => new Response('<html>login</html>', {
    headers: { 'content-type': 'text/html', 'cache-control': 'max-age=60' },
  }));
  const url = 'https://games.mofushippo.com/a.bundle';
  await (await cache.fetch(url)).text();
  assert.equal(await cache.read(url), null);
});

test('prefetch always reaches the browser session even with a fresh separate copy', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'criste-assets-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const controller = new AbortController();
  const cache = new GameAssetCache(directory, async (request, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    assert.equal(request.headers.has('if-none-match'), false);
    return new Response('asset', { headers: { 'cache-control': 'max-age=60', etag: 'v1' } });
  });
  const url = 'https://games.mofushippo.com/a.bundle';
  for (let i = 0; i < 2; i++) {
    assert.equal(await (await cache.prefetch(url, { signal: controller.signal })).text(), 'asset');
    await Promise.all([...cache.pending]);
  }
  assert.equal(calls, 2);
  assert.ok(await cache.read(url));
});

test('manifest discovery extracts static paths only and deduplicates', () => {
  const list = manifestAssets(Buffer.from('\0a.bundle\0a.bundle\0sub/b.bundle\0https://evil.com/c.bundle'),
    'https://games.mofushippo.com/assets/DefaultPackage_123.bytes');
  assert.deepEqual(list, ['https://games.mofushippo.com/assets/a.bundle',
    'https://games.mofushippo.com/assets/sub/b.bundle']);
});
