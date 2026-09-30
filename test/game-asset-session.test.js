const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGameAssetCache } = require('../src/game-asset-session');

test('asset cache leaves page protocols alone and forwards prefetch to the browser session', async () => {
  const controller = new AbortController();
  let calls = 0;
  const gameSession = {
    protocol: { handle() { assert.fail('Do not intercept browser protocols'); } },
    async fetch(request, options) {
      calls++;
      assert.equal(request.url, 'https://games.mofushippo.com/a.bundle');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.bypassCustomProtocolHandlers, undefined);
      return new Response('asset', { headers: { 'cache-control': 'no-store' } });
    },
  };
  const cache = createGameAssetCache(gameSession, 'unused-no-store-directory');
  assert.equal(await (await cache.prefetch('https://games.mofushippo.com/a.bundle', {
    signal: controller.signal,
  })).text(), 'asset');
  assert.equal(calls, 1);
  assert.equal(cache.pending.size, 0);
});
