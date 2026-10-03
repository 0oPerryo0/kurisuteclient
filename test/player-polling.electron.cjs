// Real Chromium fetch/XHR/cookie behavior against local fixtures only. The one-minute
// production interval is tested by advancing a fixture clock, not shortening it.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PlayerStateMonitor } = require('../src/player-state-monitor');
const { PlayerApiFrameDiagnostic } = require('../src/player-api-frame-diagnostic');
const { scalar, message, initialPlayerRequest, initialPlayerReply } = require('./fixtures/player-protobuf.cjs');
const profile = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'criste-polling-test-'));
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const requests = [];
  let level = 42, stamina = 120, authFailure = false, unrecognized = false;
  const requestBody = initialPlayerRequest();
  const completionRequest = Buffer.concat([scalar(1, 3004), message(3004, 'PRIVATE_STAGE')]);
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/game/') && request.method === 'POST') {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const bytes = Buffer.concat(chunks);
        requests.push({ bytes, headers: request.headers });
        response.writeHead(authFailure ? 401 : 200, { 'content-type': 'text/plain' });
        response.end(authFailure ? 'Expired' : unrecognized ? 'Unrecognized response' : bytes.equals(completionRequest)
          ? Buffer.concat([scalar(1, 3005), scalar(5, 0), message(3005, 'PRIVATE_REWARD')]) : initialPlayerReply({ level, stamina }));
      });
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/portal' ? '<iframe src="/game"></iframe>' : 'Game fixture');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let monitor, diagnostic, offset = 0;
  const base = Date.now();
  try {
    await window.loadURL(origin + '/portal');
    const game = window.webContents.mainFrame.frames[0];
    await game.executeJavaScript(`window.__fixtureNow = ${base}; Date.now = () => window.__fixtureNow;`);
    const frame = { processId: game.processId, routingId: game.routingId, url: 'https://games.mofushippo.com/game/',
      executeJavaScript(source) {
        source = source.replace("return url.protocol === 'https:' && url.hostname === 'games.mofushippo.com';",
          `return (url.protocol === 'https:' && url.hostname === 'games.mofushippo.com') || url.origin === ${JSON.stringify(origin)};`)
          .replace("['https:', 'wss:']", "['https:', 'wss:', 'http:']");
        return game.executeJavaScript(source);
      } };
    let player;
    monitor = new PlayerStateMonitor(() => [frame], value => { player = value; }, { polling: true, now: () => base + offset });
    await monitor.start();
    diagnostic = new PlayerApiFrameDiagnostic(() => [frame]); await diagnostic.start();
    await session.defaultSession.cookies.set({ url: origin, name: 'game-auth', value: 'PRIVATE_COOKIE_ONE' });
    const original = await game.executeJavaScript(`(async () => {
      const response = await fetch('/game/', { method: 'POST', credentials: 'include',
        headers: { 'x-game-auth': 'PRIVATE_HEADER' }, body: new Uint8Array(${JSON.stringify([...requestBody])}) });
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      await new Promise(resolve => setTimeout(resolve, 50)); return bytes;
    })()`);
    assert.deepEqual(Buffer.from(original), initialPlayerReply());
    await monitor.scan();
    assert.equal(monitor.refreshState.armed, true);
    assert.equal(requests.length, 1);
    offset = 59000; await game.executeJavaScript(`window.__fixtureNow = ${base + offset}`); await monitor.scan();
    assert.equal(player.stamina, 120); assert.equal(player.staminaAgeMinutes, 0);
    assert.equal(requests.length, 1);
    // A poll uses current Chromium cookies, not copied Cookie headers from the first request.
    await session.defaultSession.cookies.set({ url: origin, name: 'game-auth', value: 'PRIVATE_COOKIE_TWO' });
    stamina = 125;
    offset = 60000; await game.executeJavaScript(`window.__fixtureNow = ${base + offset}`); await monitor.scan(); await monitor.scan();
    assert.equal(requests.length, 2);
    assert.equal(player.stamina, 125);
    assert.equal(player.staminaAgeMinutes, 0);
    assert.deepEqual(requests[1].bytes, requestBody);
    assert.equal(requests[1].headers['x-game-auth'], 'PRIVATE_HEADER');
    assert.match(requests[1].headers.cookie, /PRIVATE_COOKIE_TWO/);
    assert.equal(JSON.stringify(monitor.refreshState).includes('PRIVATE_'), false);
    offset = 80000; level = 43; stamina = 130;
    await game.executeJavaScript(`window.__fixtureNow = ${base + offset}`);
    await game.executeJavaScript(`(async () => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', '/game/'); xhr.responseType = 'arraybuffer';
      const finished = new Promise(resolve => xhr.addEventListener('loadend', resolve, { once: true }));
      xhr.send(new Uint8Array(${JSON.stringify([...completionRequest])}));
      await finished; await new Promise(resolve => setTimeout(resolve, 50));
    })()`); await monitor.scan();
    assert.equal(requests.length, 3);
    assert.equal(monitor.refreshState.gameplayPending, true);
    offset = 80999; await game.executeJavaScript(`window.__fixtureNow = ${base + offset}`); await monitor.scan();
    assert.equal(requests.length, 3);
    offset = 81000; await game.executeJavaScript(`window.__fixtureNow = ${base + offset}`); await monitor.scan(); await monitor.scan();
    assert.equal(requests.length, 4);
    assert.equal(player.level, 43);
    assert.equal(player.stamina, 130);
    assert.equal(monitor.refreshState.status, 'Last gameplay refresh succeeded');
    assert.deepEqual(requests[3].bytes, requestBody, 'Refresh replays initialization, never stage completion');
    const report = await diagnostic.stopAndReport();
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
    assert.equal(window.webContents.debugger.isAttached(), false);
    unrecognized = true;
    offset = 141000; await game.executeJavaScript(`window.__fixtureNow = ${base + offset}`); await monitor.scan(); await monitor.scan();
    assert.equal(requests.length, 5);
    assert.equal(monitor.refreshState.armed, false);
    assert.equal(player.level, 43);
    assert.equal(player.stamina, 130);
    offset = 3600000; await game.executeJavaScript(`window.__fixtureNow = ${base + offset}`); await monitor.scan();
    assert.equal(requests.length, 5);
    assert.equal(player.stamina, 130);
    assert.equal(player.staminaAgeMinutes, 58);
    // A confirmed authentication failure still clears the previous user's identity.
    authFailure = true;
    await game.executeJavaScript(`(async () => {
      await fetch('/game/', { method: 'POST', body: new Uint8Array(${JSON.stringify([...requestBody])}) });
      await new Promise(resolve => setTimeout(resolve, 50));
    })()`); await monitor.scan();
    assert.equal(player, null);
    await monitor.stop();
    assert.equal(await game.executeJavaScript('window.__cristePresencePlayerReader.snapshot().refresh.armed'), false);
    console.log('ELECTRON_ONE_MINUTE_PLAYER_POLLING_PRESENCE_RETENTION_OK');
    console.log('ELECTRON_XHR_GAMEPLAY_TRIGGERED_PLAYER_REFRESH_OK');
  } finally {
    diagnostic?.finish(); await monitor?.stop(); window.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
