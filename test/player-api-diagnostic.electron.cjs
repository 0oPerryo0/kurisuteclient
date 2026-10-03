// Real CDP smoke test with a local fixture; makes no requests to the game server.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { PlayerApiDiagnostic } = require('../src/player-api-diagnostic');
const profile = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'criste-player-api-test-'));
app.setPath('userData', profile);

app.whenReady().then(async () => {
  let apiRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/player') {
      apiRequests++;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ player: { nickname: 'PRIVATE_NAME', level: 42, stamina: 120,
        maxStamina: 160, token: 'PRIVATE_TOKEN' } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Capture fixture</title>Loaded');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const capture = new PlayerApiDiagnostic(window.webContents);
  try {
    await window.loadURL(origin);
    await capture.start();
    // Test-only trust override: production only trusts the actual HTTPS game frame.
    for (const frame of capture.frames.values()) frame.game = true;
    const handle = capture.handle.bind(capture);
    capture.handle = (method, params, sessionId) => {
      if (method === 'Network.responseReceived' && params.response.url === origin + '/api/player')
        params = { ...params, response: { ...params.response, url: 'https://games.mofushippo.com/api/player' } };
      handle(method, params, sessionId);
    };
    let bodyRead;
    const completed = new Promise((resolve) => { bodyRead = resolve; });
    const read = capture.readBody.bind(capture);
    capture.readBody = async (...args) => { await read(...args); bodyRead(); };
    const data = await window.webContents.executeJavaScript(`fetch('/api/player').then(r => r.json())`);
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('No CDP response captured')), 10000))]);
    const report = await capture.stopAndReport();
    assert.equal(apiRequests, 1, 'Capture must not replay the request');
    assert.equal(data.player.nickname, 'PRIVATE_NAME', 'The game receives its unmodified response');
    assert.equal(report.responses.length, 1);
    assert.equal(report.captureMode, 'root-only');
    assert.equal(report.responses[0].candidates.find((item) => item.category === 'level').sample, 42);
    assert.equal(report.responses[0].candidates.find((item) => item.path.endsWith('.stamina')).sample, 120);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
    await window.loadURL(origin);
    assert.equal(window.webContents.getTitle(), 'Capture fixture');
    console.log('ELECTRON_PLAYER_API_ROOT_CAPTURE_REDACTION_AND_NAVIGATION_OK');
  } finally {
    capture.finish();
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
