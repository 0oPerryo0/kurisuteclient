const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PlayerApiDiagnostic, summarizePlayerJson, safeEndpoint, isGameUrl } = require('../src/player-api-diagnostic');

test('player API summary keeps candidate numbers but omits names, IDs and secrets', () => {
  const summary = summarizePlayerJson(JSON.stringify({
    data: { player: { nickname: 'PRIVATE_NAME', playerId: 'PRIVATE_ID', level: 42,
      stamina: { current: 120, max: 160 }, token: 'PRIVATE_TOKEN',
      session: { level: 999 }, email: 'PRIVATE_EMAIL' }, inventory: [{ level: 2 }, { level: 3 }] },
  }));
  assert.equal(summary.format, 'json');
  const output = JSON.stringify(summary);
  assert.equal(/PRIVATE_|token|session|playerId|email/.test(output), false);
  assert.deepEqual(summary.candidates.find((item) => item.category === 'accountName'), {
    path: '$.data.player.nickname', category: 'accountName', type: 'string', valueOmitted: true,
  });
  assert.equal(summary.candidates.find((item) => item.path === '$.data.player.level').sample, 42);
  assert.equal(summary.candidates.find((item) => item.path === '$.data.player.stamina.current').sample, 120);
  assert.equal(summary.candidates.find((item) => item.path === '$.data.player.stamina.max').sample, 160);
  assert.ok(summary.fields.some((item) => item.path === '$.data.inventory[0].level'));
  assert.equal(summary.fields.some((item) => item.path.includes('[1]')), false);
});

test('API endpoint redaction excludes queries, names, IDs and opaque segments', () => {
  assert.equal(safeEndpoint('https://games.mofushippo.com/api/v1/player/Perry/123?token=secret#secret'),
    'https://games.mofushippo.com/api/v1/player/<redacted>/<redacted>');
  assert.equal(safeEndpoint('https://user:pass@example.com/api'), null);
  assert.equal(safeEndpoint('http://example.com/api'), null);
  assert.equal(isGameUrl('https://games.mofushippo.com/game'), true);
  assert.equal(isGameUrl('https://games.mofushippo.com.evil.com/game'), false);
  assert.equal(isGameUrl('https://accounts.dmm.co.jp/login'), false);
});

test('API summary bounds depth and size and handles binary or invalid JSON', () => {
  assert.equal(summarizePlayerJson('encrypted data').format, 'non-json');
  assert.equal(summarizePlayerJson('x'.repeat(2 * 1024 * 1024 + 1)).format, 'oversized');
  let deep = { level: 1 };
  for (let i = 0; i < 20; i++) deep = { child: deep };
  assert.equal(summarizePlayerJson(JSON.stringify(deep)).candidates.length, 0);
  const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['field' + i, i]));
  assert.equal(summarizePlayerJson(JSON.stringify(wide)).fields.length, 250);
});

function mockContents() {
  const contents = new EventEmitter();
  const debuggerApi = new EventEmitter();
  let attached = false;
  const calls = [];
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; debuggerApi.emit('detach'); };
  debuggerApi.sendCommand = async (method, params, sessionId) => {
    if (sessionId === '') throw new Error('Empty session id is not allowed');
    calls.push({ method, params, sessionId });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'portal', url: 'https://games.dmm.co.jp/' },
      childFrames: [{ frame: { id: 'game', parentId: 'portal', url: 'https://games.mofushippo.com/game' } }] } };
    if (method === 'Network.getResponseBody') return { body: '{"playerLevel":42,"stamina":120,"nickname":"PRIVATE_NAME"}' };
    return {};
  };
  contents.debugger = debuggerApi;
  return { contents, debuggerApi, calls };
}

test('capture reads only completed game responses and never replays or modifies requests', async (t) => {
  const { contents, debuggerApi, calls } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  const emit = (method, params) => debuggerApi.emit('message', {}, method, params, '');
  const response = { url: 'https://games.mofushippo.com/api/player?token=SECRET', status: 200,
    mimeType: 'application/json', headers: { 'set-cookie': 'PRIVATE_COOKIE' } };
  emit('Network.responseReceived', { requestId: 'portal-request', frameId: 'portal', type: 'XHR', response });
  emit('Network.loadingFinished', { requestId: 'portal-request', encodedDataLength: 100 });
  emit('Page.frameNavigated', { frame: { id: 'third-party', parentId: 'game', url: 'https://example.com/ad' } });
  emit('Network.responseReceived', { requestId: 'ad-request', frameId: 'third-party', type: 'Fetch', response });
  emit('Network.loadingFinished', { requestId: 'ad-request', encodedDataLength: 100 });
  emit('Network.responseReceived', { requestId: 'game-request', frameId: 'game', type: 'Fetch', response });
  emit('Network.loadingFinished', { requestId: 'game-request', encodedDataLength: 100 });
  const report = await capture.stopAndReport();
  assert.equal(report.responses.length, 1);
  assert.equal(report.responses[0].candidates.find((item) => item.category === 'level').sample, 42);
  assert.equal(/PRIVATE_|SECRET/.test(JSON.stringify(report)), false);
  assert.deepEqual(calls.map((item) => item.method), ['Page.enable', 'Page.getFrameTree', 'Network.enable', 'Network.getResponseBody']);
  assert.equal(report.diagnosticVersion, 3);
  assert.equal(report.counts.responsesSeen, 3);
  assert.equal(report.counts.ignoredScope, 2);
  assert.ok(report.frameSnapshots.some((frame) => frame.game));
  assert.equal(debuggerApi.isAttached(), false);
  assert.equal(debuggerApi.listenerCount('message'), 0);
});

test('capture skips oversized and static responses and does not read WebSocket payloads', async (t) => {
  const { contents, debuggerApi, calls } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  const emit = (method, params) => debuggerApi.emit('message', {}, method, params);
  for (const [requestId, url, headers] of [
    ['large', 'https://games.mofushippo.com/api/player', { 'content-length': '99999999' }],
    ['static', 'https://games.mofushippo.com/a.bundle', {}],
  ]) emit('Network.responseReceived', { requestId, frameId: 'game', type: 'XHR',
    response: { url, status: 200, mimeType: 'application/octet-stream', headers } });
  emit('Network.webSocketCreated', { url: 'wss://games.mofushippo.com/ws?token=SECRET',
    initiator: { stack: { callFrames: [{ url: 'https://games.mofushippo.com/game.js' }] } } });
  emit('Network.webSocketFrameReceived', { response: { payloadData: 'PRIVATE_TOKEN' } });
  const report = await capture.stopAndReport();
  assert.equal(report.responses.length, 0);
  assert.equal(report.counts.skippedLarge, 1);
  assert.deepEqual(report.webSocketEndpoints, ['wss://games.mofushippo.com/ws']);
  assert.equal(calls.some((item) => item.method === 'Network.getResponseBody'), false);
});

test('capture refuses to take over an existing debugger', async () => {
  const { contents, debuggerApi } = mockContents();
  debuggerApi.attach();
  const capture = new PlayerApiDiagnostic(contents);
  await assert.rejects(() => capture.start(), /Close game DevTools/);
  assert.equal(debuggerApi.isAttached(), true);
});

test('game-script initiators identify cross-origin API calls without a frame ID', async (t) => {
  const { contents, debuggerApi } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  const emit = (method, params) => debuggerApi.emit('message', {}, method, params);
  emit('Network.requestWillBeSent', { requestId: 'worker-fetch', documentURL: '', type: 'Fetch',
    initiator: { stack: { callFrames: [{ url: 'https://games.mofushippo.com/Build/game.framework.js' }] } },
    request: { url: 'https://api.example.com/player?token=PRIVATE_TOKEN', postData: 'PRIVATE_BODY' } });
  emit('Network.responseReceived', { requestId: 'worker-fetch', type: 'Fetch',
    response: { url: 'https://api.example.com/player?token=PRIVATE_TOKEN', status: 200, mimeType: 'application/json' } });
  emit('Network.loadingFinished', { requestId: 'worker-fetch', encodedDataLength: 100 });
  const report = await capture.stopAndReport();
  assert.equal(report.counts.gameRequests, 1);
  assert.equal(report.responses.length, 1);
  assert.equal(report.responses[0].endpoint, 'https://api.example.com/player');
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
});

test('existing WebSocket frames produce transport metadata without reading payloads', async (t) => {
  const { contents, debuggerApi, calls } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  for (const [method, opcode] of [['Network.webSocketFrameReceived', 2], ['Network.webSocketFrameSent', 1]])
    debuggerApi.emit('message', {}, method, { requestId: 'already-open', response: { opcode, payloadData: 'PRIVATE_TOKEN' } });
  const report = await capture.stopAndReport();
  assert.equal(report.counts.webSocketFramesSeen, 2);
  assert.equal(report.webSocketTransports[0].endpoint, null);
  assert.equal(report.webSocketTransports[0].gameScoped, null);
  assert.equal(report.webSocketTransports[0].binaryFrames, 1);
  assert.equal(report.webSocketTransports[0].textFrames, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE_TOKEN'), false);
  assert.equal(calls.some((call) => call.method === 'Network.getResponseBody'), false);
});

test('capture does not attach to game workers or read child-session bodies', async (t) => {
  const { contents, debuggerApi, calls } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'worker-session',
    targetInfo: { type: 'worker', url: 'blob:https://games.mofushippo.com/random' } });
  debuggerApi.emit('message', {}, 'Network.responseReceived', { requestId: 'api', type: 'Other',
    response: { url: 'https://api.example.com/profile', mimeType: 'application/json', status: 200 } }, 'worker-session');
  debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId: 'api', encodedDataLength: 100 }, 'worker-session');
  const report = await capture.stopAndReport();
  assert.equal(report.captureMode, 'root-only');
  assert.equal(report.counts.childEventsIgnored, 2);
  assert.equal(report.responses.length, 0);
  assert.equal(calls.some((call) => call.method.startsWith('Target.')), false);
  assert.equal(calls.some((call) => call.method === 'Network.getResponseBody'), false);
});

test('capture ignores child target lifecycle rather than manipulating it', async (t) => {
  const { contents, debuggerApi, calls } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'untrusted',
    targetInfo: { type: 'worker', url: 'https://accounts.dmm.co.jp/auth.js' } });
  const report = await capture.stopAndReport();
  assert.equal(report.responses.length, 0);
  assert.equal(calls.some((call) => call.method.startsWith('Target.')), false);
  assert.equal(calls.some((call) => call.sessionId), false);
  const enable = calls.find((call) => call.method === 'Network.enable');
  assert.equal(enable.params.maxTotalBufferSize, 2 * 1024 * 1024);
  assert.equal(enable.params.maxResourceBufferSize, 512 * 1024);
});

test('binary API responses are reported as transport metadata without reading bodies', async (t) => {
  const { contents, debuggerApi, calls } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  debuggerApi.emit('message', {}, 'Network.responseReceived', { requestId: 'binary', frameId: 'game', type: 'Fetch',
    response: { url: 'https://api.example.com/player', status: 200, mimeType: 'application/octet-stream' } });
  debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId: 'binary', encodedDataLength: 100 });
  const report = await capture.stopAndReport();
  assert.equal(report.responses[0].format, 'not-read');
  assert.equal(calls.some((call) => call.method === 'Network.getResponseBody'), false);
});

test('capture limits simultaneous body reads to two', async (t) => {
  const { contents, debuggerApi, calls } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  t.after(() => capture.finish());
  await capture.start();
  const send = debuggerApi.sendCommand;
  let unblock;
  const paused = new Promise((resolve) => { unblock = resolve; });
  debuggerApi.sendCommand = async (...args) => {
    if (args[0] === 'Network.getResponseBody') await paused;
    return send(...args);
  };
  for (const requestId of ['one', 'two', 'three']) {
    debuggerApi.emit('message', {}, 'Network.responseReceived', { requestId, frameId: 'game', type: 'Fetch',
      response: { url: 'https://api.example.com/player', status: 200, mimeType: 'application/json' } });
    debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId, encodedDataLength: 100 });
  }
  unblock();
  const report = await capture.stopAndReport();
  assert.equal(report.counts.bodyReadsSkippedBusy, 1);
  assert.equal(calls.filter((call) => call.method === 'Network.getResponseBody').length, 2);
});

test('capture cleanup tolerates a debugger whose renderer has already exited', async () => {
  const { contents, debuggerApi } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  await capture.start();
  debuggerApi.detach = () => { throw new Error('Renderer is gone'); };
  assert.doesNotThrow(() => capture.finish('renderer-exit'));
  const report = await capture.stopAndReport();
  assert.equal(report.stoppedReason, 'renderer-exit');
  assert.equal(debuggerApi.listenerCount('message'), 0);
});

test('malformed capture events stop the diagnostic without crashing the client', async () => {
  const { contents, debuggerApi } = mockContents();
  const capture = new PlayerApiDiagnostic(contents);
  await capture.start();
  assert.doesNotThrow(() => debuggerApi.emit('message', {}, 'Network.responseReceived', { type: 'Fetch', frameId: 'game' }));
  const report = await capture.stopAndReport();
  assert.equal(report.stoppedReason, 'capture-error');
  assert.equal(report.counts.captureErrors, 1);
  assert.equal(debuggerApi.isAttached(), false);
});
