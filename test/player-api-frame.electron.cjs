// Tests the observer inside an iframe with no debugger or protocol interception.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { initialPlayerReply } = require('./fixtures/player-protobuf.cjs');
const { PlayerApiFrameDiagnostic } = require('../src/player-api-frame-diagnostic');
const profile = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'criste-frame-api-test-'));
app.setPath('userData', profile);

app.whenReady().then(async () => {
  let requests = 0;
  const encoded = zlib.gzipSync(JSON.stringify({ nickname: 'PRIVATE_NAME', playerLevel: 42,
    stamina: 120, token: 'PRIVATE_TOKEN' })).toString('base64');
  const playerReply = initialPlayerReply();
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/game/')) {
      requests++;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(request.url.includes('protobuf=1') ? playerReply : encoded);
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/portal' ? '<title>Portal</title><iframe src="/game"></iframe>' : '<title>Game fixture</title>Game');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let capture;
  try {
    await window.loadURL(origin + '/portal');
    const game = window.webContents.mainFrame.frames[0];
    assert.ok(game);
    // Test-only adapter allows local HTTP instead of the production HTTPS game origin.
    const frame = { processId: game.processId, routingId: game.routingId, url: 'https://games.mofushippo.com/game',
      executeJavaScript(source) {
        source = source.replace("if (!isGameUrl(location.href)) return { installed: false };",
          `if (location.href !== ${JSON.stringify(origin + '/game')}) return { installed: false };`)
          .replace("['https:', 'wss:']", "['https:', 'wss:', 'http:']");
        source = source.replace("return url.protocol === 'https:' && url.hostname === 'games.mofushippo.com';",
          `return (url.protocol === 'https:' && url.hostname === 'games.mofushippo.com') || url.origin === ${JSON.stringify(origin)};`);
        return game.executeJavaScript(source);
      } };
    capture = new PlayerApiFrameDiagnostic(() => [frame]);
    await capture.start();
    assert.equal(window.webContents.debugger.isAttached(), false);
    assert.equal(await window.webContents.executeJavaScript('typeof window.__cristePlayerApiCapture'), 'undefined');
    const result = await game.executeJavaScript(`(async () => {
      const original = await (await fetch('/game/?token=PRIVATE_TOKEN')).text();
      const xhr = await new Promise(resolve => {
        const request = new XMLHttpRequest(); request.open('GET', '/game/');
        request.onload = () => resolve(request.responseText); request.send();
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      return { fetchBody: original, xhrBody: xhr };
    })()`);
    assert.equal(result.fetchBody, encoded);
    assert.equal(result.xhrBody, encoded);
    const binary = await game.executeJavaScript(`(async () => {
      const original = await (await fetch('/game/?protobuf=1')).arrayBuffer();
      const xhr = await new Promise(resolve => {
        const request = new XMLHttpRequest(); request.open('GET', '/game/?protobuf=1');
        request.responseType = 'arraybuffer';
        request.onload = () => resolve(request.response); request.send();
      });
      return { fetchBytes: Array.from(new Uint8Array(original)), xhrBytes: Array.from(new Uint8Array(xhr)) };
    })()`);
    assert.deepEqual(Buffer.from(binary.fetchBytes), playerReply);
    assert.deepEqual(Buffer.from(binary.xhrBytes), playerReply);
    const report = await capture.stopAndReport();
    assert.equal(report.diagnosticVersion, 8);
    assert.equal(report.gameFramesAttached, 1);
    assert.equal(report.responses.length, 4);
    assert.equal(report.responses[0].decoder, 'game-wire');
    assert.deepEqual(report.responses[0].wire.decodingSteps, ['base64', 'gzip']);
    assert.equal(report.responses[0].candidates.find((field) => field.category === 'level').sample, 42);
    assert.equal(report.counts.playerResponses, 2);
    assert.equal(report.installedObserverVersions[0], 8);
    for (const response of report.responses.filter((entry) => entry.protobufPlayer)) {
      assert.equal(response.candidates.find((field) => field.category === 'level').sample, 42);
      assert.equal(response.candidates.find((field) => field.category === 'stamina').sample, 120);
      assert.equal(response.candidates.find((field) => field.category === 'accountName').valueOmitted, true);
    }
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
    assert.equal(requests, 4, 'Observer must not replay requests');
    assert.equal(window.webContents.debugger.isAttached(), false);
    assert.equal(await game.executeJavaScript('window.__cristePlayerApiCapture.active()'), false);
    console.log('ELECTRON_IFRAME_FETCH_XHR_REDACTION_NO_DEBUGGER_OK');
  } finally {
    capture?.finish();
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
