const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { playerStateFrameScript } = require('../src/player-state-frame');
const { PlayerStateMonitor } = require('../src/player-state-monitor');
const { playerApiFrameScript } = require('../src/player-api-frame-script');
const { scalar, message, initialPlayerReply } = require('./fixtures/player-protobuf.cjs');

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
function fixture(t, shareName = false) {
  let body = initialPlayerReply(), calls = 0, responseUrl = 'https://games.mofushippo.com/game/';
  const nativeFetch = function() {
    calls++;
    const response = new Response(body, { headers: { 'content-type': 'text/plain' } });
    Object.defineProperty(response, 'url', { value: responseUrl });
    return Promise.resolve(response);
  };
  class Xhr extends EventTarget {
    send() {
      this.status = 200; this.responseURL = responseUrl;
      this.responseType = 'arraybuffer'; this.response = Uint8Array.from(body).buffer;
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const window = { fetch: nativeFetch, XMLHttpRequest: Xhr };
  const context = vm.createContext({ window, location: { href: responseUrl }, URL,
    TextEncoder, TextDecoder, Uint8Array, Blob, DecompressionStream, atob, setTimeout, clearTimeout });
  vm.runInContext(playerStateFrameScript('live', shareName), context);
  t.after(() => { window.__cristePresencePlayerReader?.stop(); window.__cristePlayerApiCapture?.stop(); });
  return { window, context, nativeFetch, Xhr, calls: () => calls,
    setBody(value) { body = value; }, setUrl(value) { responseUrl = value; } };
}

test('live reader keeps player values in memory and nickname is opt-in', async (t) => {
  for (const shareName of [false, true]) {
    const f = fixture(t, shareName);
    const response = await f.window.fetch('/game/');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), initialPlayerReply());
    await flush();
    const player = f.window.__cristePresencePlayerReader.snapshot().player;
    assert.equal(player.level, 42);
    assert.equal(player.stamina, 120);
    assert.equal(player.nickname, shareName ? 'PRIVATE_NAME' : null);
    assert.equal(f.calls(), 1);
    assert.equal(JSON.stringify(player).includes('PRIVATE_TOKEN'), false);
    f.window.__cristePresencePlayerReader.stop();
    assert.equal(f.window.fetch, f.nativeFetch);
    assert.equal(f.window.__cristePresencePlayerReader.snapshot().player, null);
  }
});

test('XHR energy updates are merged but unrelated replies never supply player fields', async (t) => {
  const f = fixture(t);
  await f.window.fetch('/game/'); await flush();
  f.setBody(Buffer.concat([scalar(1, 1022), message(1022, scalar(1, 100))]));
  new f.window.XMLHttpRequest().send(); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player.stamina, 100);
  f.setBody(Buffer.concat([scalar(1, 1024), message(1024, Buffer.from('PRIVATE_QUEST'))]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player.stamina, 100);
  f.setBody(Buffer.concat([scalar(1, 3003), message(3003, scalar(1, 10))]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player.stamina, 10);
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player.lastKnown, false);
  f.setBody(Buffer.concat([scalar(1, 4005), message(4005, scalar(1, 999))]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player.stamina, 10);
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player.lastKnown, true);
  f.setBody(Buffer.concat([scalar(1, 11), message(11, Buffer.from('PRIVATE_TOKEN'))]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player, null);
});

test('live nickname never leaks into a simultaneous API diagnostic', async (t) => {
  const f = fixture(t, true);
  vm.runInContext(playerApiFrameScript('diagnostic'), f.context);
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player.nickname, 'PRIVATE_NAME');
  const report = f.window.__cristePlayerApiCapture.takeReport();
  assert.equal(report.responses[0].candidates.find((field) => field.category === 'level').sample, 42);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  f.window.__cristePresencePlayerReader.stop();
  f.window.__cristePlayerApiCapture.stop();
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player, null);
});

test('live reader ignores other response origins and other frame origins', async (t) => {
  const f = fixture(t, true);
  f.setUrl('https://other.example/game/');
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.window.__cristePresencePlayerReader.snapshot().player, null);
  const result = vm.runInNewContext(playerStateFrameScript('test'), {
    window: {}, location: { href: 'https://accounts.dmm.co.jp/' }, URL,
  });
  assert.equal(result.installed, false);
});

test('monitor retains last-read stamina, clears navigation state and does not resurrect a retired document', async (t) => {
  const f = fixture(t, true);
  let now = Date.now();
  let frames;
  const frame = { url: 'https://games.mofushippo.com/game/', processId: 1, routingId: 2,
    executeJavaScript: (source) => Promise.resolve(vm.runInContext(source, f.context)) };
  frames = [frame];
  let latest;
  const monitor = new PlayerStateMonitor(() => frames, (player) => { latest = player; }, { shareName: true, now: () => now });
  t.after(() => monitor.stop());
  await monitor.start();
  await f.window.fetch('/game/'); await flush(); await monitor.scan();
  assert.equal(latest.nickname, 'PRIVATE_NAME');
  assert.equal(latest.stamina, 120);
  now += 121000; await monitor.scan();
  assert.equal(latest.stamina, 120);
  assert.equal(latest.staminaAgeMinutes, 2);
  monitor.reset(); await f.window.fetch('/game/'); await flush(); await monitor.scan();
  assert.equal(latest, null);
  // Simulate replacing the document/JS world while reusing its routing ID.
  f.window.__cristePresencePlayerReader.stop();
  await monitor.scan(); await f.window.fetch('/game/'); await flush(); await monitor.scan();
  assert.equal(latest.level, 42);
  f.window.__cristePresencePlayerReader.stop();
  await monitor.scan();
  assert.equal(latest, null);
  await f.window.fetch('/game/'); await flush(); await monitor.scan();
  assert.equal(latest.level, 42);
  frames = []; await monitor.scan();
  assert.equal(latest, null);
});

test('a transient frame read error does not retire the document or clear presence', async (t) => {
  const f = fixture(t);
  let unavailable = false, latest;
  const frame = { url: 'https://games.mofushippo.com/game/', processId: 1, routingId: 2,
    async executeJavaScript(source) {
      if (unavailable) throw new Error('Temporarily unavailable');
      return vm.runInContext(source, f.context);
    } };
  const monitor = new PlayerStateMonitor(() => [frame], player => { latest = player; });
  t.after(() => monitor.stop());
  await monitor.start(); await f.window.fetch('/game/'); await flush(); await monitor.scan();
  assert.equal(latest.level, 42);
  unavailable = true; await monitor.scan();
  assert.equal(latest.level, 42);
  assert.equal(monitor.retiredDocuments.size, 0);
  unavailable = false; await monitor.scan();
  assert.equal(latest.stamina, 120);
  monitor.reset();
  assert.equal(latest, null);
});
