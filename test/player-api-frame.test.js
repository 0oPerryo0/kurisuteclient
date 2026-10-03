const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { playerApiFrameScript } = require('../src/player-api-frame-script');
const { PlayerApiFrameDiagnostic } = require('../src/player-api-frame-diagnostic');
const { initialPlayerReply } = require('./fixtures/player-protobuf.cjs');

const payload = JSON.stringify({ player: { nickname: 'PRIVATE_NAME', level: 42, stamina: 120,
  maxStamina: 160, playerId: 'PRIVATE_ID', token: 'PRIVATE_TOKEN' } });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function fixture(t, hostname = 'games.mofushippo.com', options = {}) {
  let calls = 0, lastPromise;
  const nativeFetch = function() {
    calls++;
    const response = new Response(options.body || payload, { headers: { 'content-type': options.mimeType || 'application/json' } });
    Object.defineProperty(response, 'url', { value: options.url || 'https://games.mofushippo.com/game?token=PRIVATE_TOKEN' });
    lastPromise = Promise.resolve(response);
    return lastPromise;
  };
  class Xhr extends EventTarget {
    constructor() { super(); this.responseType = ''; }
    send() {
      this.responseURL = 'https://games.mofushippo.com/profile?token=PRIVATE_TOKEN';
      this.status = 200; this.responseText = payload;
      this.dispatchEvent(new Event('loadend'));
    }
    getResponseHeader(name) { return name === 'content-type' ? 'application/json' : null; }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.sent = []; }
    send(value) { this.sent.push(value); }
    receive(data) { const event = new Event('message'); Object.defineProperty(event, 'data', { value: data }); this.dispatchEvent(event); }
  }
  const window = { fetch: nativeFetch, XMLHttpRequest: Xhr, WebSocket: Socket };
  const context = vm.createContext({ window, location: { href: 'https://' + hostname + '/game' },
    URL, TextEncoder, TextDecoder, Uint8Array, Blob, DecompressionStream, atob, setTimeout, clearTimeout });
  t.after(() => window.__cristePlayerApiCapture?.stop());
  return { window, context, nativeFetch, Xhr, Socket, calls: () => calls, lastPromise: () => lastPromise };
}

test('frame observer preserves fetch promises/bodies and never sends extra requests', async (t) => {
  const f = fixture(t);
  vm.runInContext(playerApiFrameScript('test'), f.context);
  const promise = f.window.fetch('https://api.example.com/player');
  assert.equal(promise, f.lastPromise());
  assert.equal(await (await promise).text(), payload);
  await flush();
  const report = f.window.__cristePlayerApiCapture.takeReport();
  assert.equal(f.calls(), 1);
  assert.equal(report.responses.length, 1);
  assert.equal(report.responses[0].candidates.find((field) => field.category === 'level').sample, 42);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  f.window.__cristePlayerApiCapture.stop();
  assert.equal(f.window.fetch, f.nativeFetch);
});

test('frame observer summarizes XHR and incoming WebSocket JSON without outgoing secrets', (t) => {
  const f = fixture(t);
  const nativeSend = f.Xhr.prototype.send;
  vm.runInContext(playerApiFrameScript('test'), f.context);
  const xhr = new f.window.XMLHttpRequest();
  xhr.send();
  assert.equal(xhr.responseText, payload);
  const socket = new f.window.WebSocket('wss://api.example.com/ws?token=PRIVATE_TOKEN');
  assert.ok(socket instanceof f.Socket);
  assert.equal(f.window.WebSocket.OPEN, 1);
  socket.send('PRIVATE_OUTGOING');
  socket.receive(payload);
  socket.receive(new Uint8Array([1, 2]));
  const report = f.window.__cristePlayerApiCapture.takeReport();
  assert.equal(report.responses.length, 2);
  assert.equal(report.counts.webSocketFramesSeen, 2);
  assert.equal(report.webSocketTransports[0].binaryFrames, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.deepEqual(socket.sent, ['PRIVATE_OUTGOING']);
  f.window.__cristePlayerApiCapture.stop();
  assert.equal(f.window.XMLHttpRequest.prototype.send, nativeSend);
  assert.equal(f.window.WebSocket, f.Socket);
});

test('frame observer ignores unrelated origins and does not overwrite later game changes', (t) => {
  const unrelated = fixture(t, 'accounts.dmm.co.jp');
  assert.equal(vm.runInContext(playerApiFrameScript('test'), unrelated.context).installed, false);
  assert.equal(unrelated.window.fetch, unrelated.nativeFetch);
  const f = fixture(t);
  vm.runInContext(playerApiFrameScript('test'), f.context);
  const laterFetch = () => {};
  f.window.fetch = laterFetch;
  f.window.__cristePlayerApiCapture.stop();
  assert.equal(f.window.fetch, laterFetch);
});

test('frame capture manager drains redacted reports and restores hooks without a debugger', async (t) => {
  const f = fixture(t);
  const frame = { url: 'https://games.mofushippo.com/game', processId: 1, routingId: 2,
    async executeJavaScript(source) { return vm.runInContext(source, f.context); } };
  const capture = new PlayerApiFrameDiagnostic(() => [frame]);
  t.after(() => capture.finish());
  await capture.start();
  await (await f.window.fetch('https://api.example.com/player')).text();
  await flush();
  await capture.scan();
  const report = await capture.stopAndReport();
  assert.equal(report.diagnosticVersion, 8);
  assert.equal(report.captureMode, 'game-frame-observer');
  assert.equal(report.gameFramesAttached, 1);
  assert.equal(report.installedHooks[0].fetch, true);
  assert.equal(report.responses.length, 1);
  assert.equal(report.counts.gameRequests, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.equal(f.window.fetch, f.nativeFetch);
  assert.equal(f.calls(), 1);
});

test('trailing-slash /game/ responses use the wire decoder rather than plain JSON fallback', async (t) => {
  const encoded = Buffer.from(payload).toString('base64');
  const f = fixture(t, 'games.mofushippo.com', { body: encoded, mimeType: 'text/plain',
    url: 'https://games.mofushippo.com/game/?token=PRIVATE_TOKEN' });
  vm.runInContext(playerApiFrameScript('test'), f.context);
  assert.equal(await (await f.window.fetch('https://games.mofushippo.com/game/')).text(), encoded);
  await f.window.__cristePlayerApiCapture.whenIdle();
  const report = f.window.__cristePlayerApiCapture.takeReport();
  assert.equal(report.responses[0].decoder, 'game-wire');
  assert.equal(report.responses[0].format, 'json');
  assert.equal(report.responses[0].wire.decodingSteps[0], 'base64');
  assert.equal(report.responses[0].candidates.find((field) => field.category === 'level').sample, 42);
  assert.equal(report.counts.wireResponses, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
});

test('frame observer maps binary player replies without changing the original response', async (t) => {
  const bytes = initialPlayerReply();
  const f = fixture(t, 'games.mofushippo.com', { body: bytes, mimeType: 'text/plain',
    url: 'https://games.mofushippo.com/game/' });
  const installed = vm.runInContext(playerApiFrameScript('test'), f.context);
  assert.equal(installed.observerVersion, 8);
  const response = await f.window.fetch('https://games.mofushippo.com/game/');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await f.window.__cristePlayerApiCapture.whenIdle();
  const report = f.window.__cristePlayerApiCapture.takeReport();
  assert.equal(report.counts.playerResponses, 1);
  assert.equal(report.responses[0].format, 'protobuf-player-candidate');
  assert.equal(report.responses[0].candidates.find((field) => field.category === 'stamina').sample, 120);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.equal(f.calls(), 1);
});
