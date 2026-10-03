const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { playerStateFrameScript } = require('../src/player-state-frame');
const { PlayerStateMonitor } = require('../src/player-state-monitor');
const { isPlayerRefreshRequest } = require('../src/player-refresh-request');
const { activityForPlayer } = require('../src/discord-presence');
const { scalar, message, initialPlayerRequest, initialPlayerReply } = require('./fixtures/player-protobuf.cjs');

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function fixture(t, { polling = true, shareName = false } = {}) {
  let now = Date.now(), status = 200, body = initialPlayerReply(), responseHeaders = {}, handler;
  const calls = [];
  class ClockDate extends Date { static now() { return now; } }
  const makeResponse = () => {
    const response = new Response(body, { status, headers: { 'content-type': 'text/plain', ...responseHeaders } });
    Object.defineProperty(response, 'url', { value: 'https://games.mofushippo.com/game/' });
    return response;
  };
  const nativeFetch = async (input, init) => {
    calls.push({ input, init });
    if (handler) return handler(input, init);
    if (input instanceof Request) await input.arrayBuffer(); // Original Request body must remain readable.
    return makeResponse();
  };
  class Xhr extends EventTarget {
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(bytes) {
      this.sentBody = bytes;
      this.status = status; this.responseURL = 'https://games.mofushippo.com/game/';
      this.responseType = 'arraybuffer'; this.response = Uint8Array.from(body).buffer;
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const events = new EventTarget();
  const window = { fetch: nativeFetch, XMLHttpRequest: Xhr,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  const context = vm.createContext({ window, location: { href: 'https://games.mofushippo.com/game/' },
    URL, Request, Headers, AbortController, TextEncoder, TextDecoder, Uint8Array, Blob, DecompressionStream,
    atob, setTimeout, clearTimeout, Date: ClockDate });
  vm.runInContext(playerStateFrameScript('poll-test', shareName, polling), context);
  t.after(() => window.__cristePresencePlayerReader?.stop());
  return { window, context, calls, Xhr, events, clock: () => now, advance(ms) { now += ms; },
    watch: () => window.__cristePresencePlayerReader,
    setResponse(value, code = 200, headers = {}) { body = value; status = code; responseHeaders = headers; },
    setHandler(value) { handler = value; },
    async initialize(bytes = initialPlayerRequest(), input = '/game/') {
      await (await window.fetch(input, { method: 'POST', body: bytes, credentials: 'include',
        headers: { 'content-type': 'application/octet-stream', 'x-game-auth': 'PRIVATE_HEADER' } })).arrayBuffer();
      await flush();
    } };
}

test('refresh request allowlist rejects nonempty initialization, login, purchases and battle requests', () => {
  assert.equal(isPlayerRefreshRequest(initialPlayerRequest()), true);
  for (const tag of [10, 14, 1021, 1067, 3002, 3004])
    assert.equal(isPlayerRefreshRequest(Buffer.concat([scalar(1, tag), message(tag, Buffer.alloc(0))])), false);
  for (const bytes of [message(100, Buffer.alloc(0)),
    Buffer.concat([scalar(1, 100), message(100, scalar(1, 1))]),
    Buffer.concat([initialPlayerRequest(), message(100, Buffer.alloc(0))]),
    Buffer.concat([initialPlayerRequest(), scalar(5, 1)]),
    initialPlayerRequest().subarray(0, initialPlayerRequest().length - 1), Buffer.alloc(9000)])
    assert.equal(isPlayerRefreshRequest(bytes), false);
});

test('polling is opt-in and waits one minute after a matched natural player response', async (t) => {
  const disabled = fixture(t, { polling: false });
  await disabled.initialize(); disabled.advance(900000); await disabled.watch().pollIfDue();
  assert.equal(disabled.calls.length, 1);
  const f = fixture(t);
  await f.watch().pollIfDue(); assert.equal(f.calls.length, 0);
  await f.initialize();
  const before = f.watch().snapshot();
  assert.equal(before.refresh.armed, true);
  assert.equal(before.refresh.nextPollAt, f.clock() + 60000);
  assert.equal(JSON.stringify(before).includes('PRIVATE_'), false);
  f.advance(59999); await f.watch().pollIfDue(); assert.equal(f.calls.length, 1);
  f.advance(1); await f.watch().pollIfDue();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(Buffer.from(f.calls[1].init.body), initialPlayerRequest());
  assert.equal(f.calls[1].init.credentials, 'include');
  assert.equal(f.calls[1].init.headers.get('x-game-auth'), 'PRIVATE_HEADER');
  assert.equal(f.calls[1].init.redirect, 'error');
  assert.equal(f.watch().snapshot().refresh.status, 'Last refresh succeeded');
  await f.watch().pollIfDue(); assert.equal(f.calls.length, 2);
});

test('unsupported requests and mismatched responses never arm a refresh', async (t) => {
  const f = fixture(t);
  await f.initialize(Buffer.concat([scalar(1, 3002), message(3002, Buffer.alloc(0))]));
  assert.equal(f.watch().snapshot().refresh.armed, false);
  f.setResponse(Buffer.concat([scalar(1, 11), message(11, Buffer.from('PRIVATE_TOKEN'))]));
  await f.initialize(); f.advance(600000); await f.watch().pollIfDue();
  assert.equal(f.calls.length, 2);
  assert.equal(f.watch().snapshot().refresh.armed, false);
});

test('Request and XHR capture preserve originals and credentials never leave frame snapshots', async (t) => {
  const f = fixture(t);
  const request = new Request('https://games.mofushippo.com/game/', { method: 'POST', body: initialPlayerRequest(), credentials: 'include' });
  await f.window.fetch(request); await flush();
  assert.equal(request.bodyUsed, true);
  assert.equal(f.watch().snapshot().refresh.armed, true);
  const g = fixture(t);
  const xhr = new g.window.XMLHttpRequest();
  xhr.open('POST', '/game/'); xhr.setRequestHeader('x-game-auth', 'PRIVATE_HEADER');
  xhr.withCredentials = true; xhr.send(initialPlayerRequest()); await flush();
  assert.equal(g.watch().snapshot().refresh.armed, true);
  g.advance(60000); await g.watch().pollIfDue();
  assert.equal(g.calls[0].init.headers.get('x-game-auth'), 'PRIVATE_HEADER');
  assert.equal(JSON.stringify(g.watch().snapshot()).includes('PRIVATE_'), false);
});

test('server failures back off and Retry-After is respected; authentication failure stops refresh', async (t) => {
  const f = fixture(t); await f.initialize();
  f.setResponse('server busy', 429, { 'retry-after': '1200' });
  f.advance(60000); await f.watch().pollIfDue();
  assert.equal(f.watch().snapshot().refresh.failures, 1);
  assert.equal(f.watch().snapshot().refresh.nextPollAt, f.clock() + 1200000);
  assert.equal(f.watch().snapshot().refresh.armed, true);
  f.advance(1199999); await f.watch().pollIfDue(); assert.equal(f.calls.length, 2);
  f.advance(1); f.setResponse('unauthorized', 401); await f.watch().pollIfDue();
  assert.equal(f.watch().snapshot().refresh.armed, false);
  assert.equal(f.watch().snapshot().player, null);
  f.advance(3600000); await f.watch().pollIfDue(); assert.equal(f.calls.length, 3);
});

test('stop, navigation and session changes abort pending refreshes and prevent reuse', async (t) => {
  for (const exit of ['stop', 'pagehide', 'pause']) {
    const f = fixture(t); await f.initialize(); f.advance(60000);
    let aborted = false;
    f.setHandler((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true });
    }));
    const pending = f.watch().pollIfDue(); await flush();
    if (exit === 'stop') f.watch().stop();
    else if (exit === 'pause') f.watch().pausePolling();
    else f.events.dispatchEvent(new Event('pagehide'));
    await pending;
    assert.equal(aborted, true);
    assert.equal(f.watch().snapshot().refresh.armed, false);
    assert.equal(f.calls.length, 2);
  }
});

test('monitor refreshes only the selected frame each minute and retains aged samples until reload', async (t) => {
  const f = fixture(t), g = fixture(t);
  g.advance(f.clock() - g.clock());
  const frames = [f, g].map((fixture, i) => ({ url: 'https://games.mofushippo.com/game/', processId: 1, routingId: i + 1,
    executeJavaScript: source => Promise.resolve(vm.runInContext(source, fixture.context)) }));
  let latest;
  const monitor = new PlayerStateMonitor(() => frames, player => { latest = player; }, { polling: true, now: () => f.clock() });
  t.after(() => monitor.stop());
  await monitor.start(); await f.initialize(); await g.initialize(); await monitor.scan();
  assert.equal(monitor.owner, '1:2');
  f.advance(59000); g.advance(59000); await monitor.scan();
  assert.equal(latest.stamina, 120);
  assert.equal(latest.staminaAgeMinutes, 0);
  assert.equal(activityForPlayer(latest).state, 'Stamina: 120 (last read 0m ago)');
  f.advance(1000); g.advance(1000); await monitor.scan();
  assert.equal(f.calls.length, 1);
  assert.equal(g.calls.length, 2);
  f.advance(601000); g.advance(601000);
  assert.equal(monitor.snapshot().stamina, 120);
  assert.equal(monitor.snapshot().staminaAgeMinutes, 11);
  monitor.reset(); await flush();
  assert.equal(g.watch().snapshot().refresh.armed, false);
});

test('an unrecognized refresh retains level, nickname and stamina rather than clearing presence', async (t) => {
  const f = fixture(t, { shareName: true }); await f.initialize();
  f.setResponse(Buffer.concat([scalar(1, 101), scalar(5, 1)]));
  f.advance(60000); await f.watch().pollIfDue();
  assert.equal(f.watch().snapshot().refresh.armed, false);
  assert.equal(f.watch().snapshot().player.level, 42);
  assert.equal(f.watch().snapshot().player.stamina, 120);
  assert.equal(f.watch().snapshot().player.nickname, 'PRIVATE_NAME');
  assert.equal(f.watch().snapshot().player.lastKnown, true);
  f.advance(3600000); await f.watch().pollIfDue();
  assert.equal(f.calls.length, 2, 'A rejected request is not blindly repeated');
  assert.equal(f.watch().snapshot().player.level, 42);
  f.watch().stop();
  assert.equal(f.watch().snapshot().player, null);
});

test('temporary refresh failures retain presence while backing off, then recover without reload', async (t) => {
  const f = fixture(t); await f.initialize();
  f.setResponse('busy', 503); f.advance(60000); await f.watch().pollIfDue();
  assert.equal(f.watch().snapshot().player.level, 42);
  assert.equal(f.watch().snapshot().player.stamina, 120);
  assert.equal(f.watch().snapshot().refresh.nextPollAt, f.clock() + 120000);
  f.advance(120000); f.setResponse(initialPlayerReply({ level: 43, stamina: 125 })); await f.watch().pollIfDue();
  assert.equal(f.watch().snapshot().player.level, 43);
  assert.equal(f.watch().snapshot().player.stamina, 125);
  assert.equal(f.watch().snapshot().refresh.status, 'Last refresh succeeded');
});

test('stage-start responses update stamina immediately without an extra game request', async (t) => {
  const f = fixture(t); await f.initialize();
  f.setResponse(Buffer.concat([scalar(1, 3003), message(3003, scalar(1, 110))]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.watch().snapshot().player.stamina, 110);
  assert.equal(f.watch().snapshot().player.level, 42);
  assert.equal(f.watch().snapshot().refresh.gameplayPending, false);
  await f.watch().pollIfDue();
  assert.equal(f.calls.length, 2, 'Only the original initialization and gameplay requests were sent');
});

test('stage completion via fetch or XHR queues an early player refresh and keeps the minute fallback', async (t) => {
  for (const transport of ['fetch', 'xhr']) {
    const f = fixture(t); await f.initialize(); f.advance(10000);
    f.setResponse(Buffer.concat([scalar(1, 3005), scalar(5, 0), message(3005, 'PRIVATE_REWARD')]));
    if (transport === 'fetch') await f.window.fetch('/game/');
    else {
      const xhr = new f.window.XMLHttpRequest(); xhr.open('POST', '/game/');
      xhr.send(Buffer.concat([scalar(1, 3004), message(3004, 'PRIVATE_STAGE')]));
      assert.equal(xhr.sentBody.includes(Buffer.from('PRIVATE_STAGE')), true);
    }
    await flush();
    assert.equal(f.watch().snapshot().refresh.gameplayPending, true);
    assert.equal(f.watch().snapshot().refresh.nextPollAt, f.clock() + 1000);
    assert.equal(JSON.stringify(f.watch().snapshot()).includes('PRIVATE_'), false);
    const before = f.calls.length;
    f.advance(999); await f.watch().pollIfDue(); assert.equal(f.calls.length, before);
    f.setResponse(initialPlayerReply({ level: 43, stamina: 130 }));
    f.advance(1); await f.watch().pollIfDue();
    assert.equal(f.calls.length, before + 1);
    assert.deepEqual(Buffer.from(f.calls.at(-1).init.body), initialPlayerRequest(), 'Never replay the stage action');
    assert.equal(f.watch().snapshot().player.level, 43);
    assert.equal(f.watch().snapshot().player.stamina, 130);
    assert.equal(f.watch().snapshot().refresh.gameplayPending, false);
    assert.equal(f.watch().snapshot().refresh.status, 'Last gameplay refresh succeeded');
    assert.equal(f.watch().snapshot().refresh.nextPollAt, f.clock() + 60000);
  }
});

test('gameplay bursts coalesce and extra refreshes are spaced at least 15 seconds apart', async (t) => {
  const f = fixture(t); await f.initialize();
  f.setResponse(Buffer.concat([scalar(1, 3009), message(3009, '')]));
  for (let i = 0; i < 3; i++) { await f.window.fetch('/game/'); await flush(); }
  assert.equal(f.watch().snapshot().refresh.nextPollAt, f.clock() + 1000);
  f.setResponse(initialPlayerReply()); f.advance(1000); await f.watch().pollIfDue();
  assert.equal(f.calls.length, 5);
  f.setResponse(Buffer.concat([scalar(1, 3035), message(3035, '')]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.watch().snapshot().refresh.nextPollAt, f.clock() + 15000);
  f.setResponse(initialPlayerReply()); f.advance(14999); await f.watch().pollIfDue();
  assert.equal(f.calls.length, 6);
  f.advance(1); await f.watch().pollIfDue(); assert.equal(f.calls.length, 7);
});

test('gameplay cannot bypass Retry-After, arm an unobserved template or send requests when disabled', async (t) => {
  const f = fixture(t); await f.initialize(); f.advance(60000);
  f.setResponse('busy', 429, { 'retry-after': '1200' }); await f.watch().pollIfDue();
  const retryAt = f.watch().snapshot().refresh.nextPollAt;
  f.setResponse(Buffer.concat([scalar(1, 3055), message(3055, '')]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.watch().snapshot().refresh.gameplayPending, true);
  assert.equal(f.watch().snapshot().refresh.nextPollAt, retryAt);
  f.advance(1199999); await f.watch().pollIfDue(); assert.equal(f.calls.length, 3);
  f.advance(1); f.setResponse(initialPlayerReply()); await f.watch().pollIfDue();
  assert.equal(f.calls.length, 4);
  for (const polling of [false, true]) {
    const g = fixture(t, { polling });
    if (!polling) await g.initialize();
    g.setResponse(Buffer.concat([scalar(1, 3005), message(3005, '')]));
    await g.window.fetch('/game/'); await flush();
    assert.equal(g.watch().snapshot().refresh.gameplayPending, false);
    const count = g.calls.length; g.advance(1000); await g.watch().pollIfDue();
    assert.equal(g.calls.length, count);
  }
});

test('unknown responses do not trigger requests; reset cancels queued gameplay refreshes', async (t) => {
  const f = fixture(t); await f.initialize();
  f.setResponse(Buffer.concat([scalar(1, 4005), message(4005, '')]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.watch().snapshot().refresh.gameplayPending, false);
  f.setResponse(Buffer.concat([scalar(1, 3005), message(3005, '')]));
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.watch().snapshot().refresh.gameplayPending, true);
  f.watch().pausePolling(); f.advance(1000); await f.watch().pollIfDue();
  assert.equal(f.calls.length, 3);
  assert.equal(f.watch().snapshot().refresh.gameplayPending, false);
});

test('gameplay arriving during a refresh is queued once without overlapping requests or stale overwrites', async (t) => {
  const f = fixture(t); await f.initialize();
  const completed = Buffer.concat([scalar(1, 3005), message(3005, '')]);
  f.setResponse(completed); await f.window.fetch('/game/'); await flush(); f.advance(1000);
  const reply = (bytes) => {
    const response = new Response(bytes);
    Object.defineProperty(response, 'url', { value: 'https://games.mofushippo.com/game/' });
    return response;
  };
  let resolvePoll;
  f.setHandler((_input, init) => init?.signal ? new Promise(resolve => { resolvePoll = resolve; }) : reply(completed));
  const pending = f.watch().pollIfDue(); await flush();
  assert.equal(f.watch().snapshot().refresh.busy, true);
  await f.window.fetch('/game/'); await flush();
  assert.equal(f.watch().snapshot().refresh.gameplayPending, true);
  await f.watch().pollIfDue(); assert.equal(f.calls.length, 4);
  resolvePoll(reply(initialPlayerReply({ level: 43, stamina: 125 }))); await pending;
  assert.equal(f.watch().snapshot().refresh.busy, false);
  assert.equal(f.watch().snapshot().refresh.gameplayPending, true);
  assert.equal(f.watch().snapshot().player.level, 42, 'A newer gameplay signal prevents applying an earlier sample');
  f.setHandler(null); f.setResponse(initialPlayerReply({ level: 44, stamina: 130 }));
  f.advance(14999); await f.watch().pollIfDue(); assert.equal(f.calls.length, 4);
  f.advance(1); await f.watch().pollIfDue(); assert.equal(f.calls.length, 5);
  assert.equal(f.watch().snapshot().player.level, 44);
  assert.equal(f.watch().snapshot().player.stamina, 130);
  assert.equal(f.watch().snapshot().refresh.gameplayPending, false);
});
