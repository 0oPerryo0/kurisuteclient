// Run with Electron, not node --test: verifies real page navigation and native caching.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createGameAssetCache } = require('../src/game-asset-session');

const profile = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'criste-navigation-test-'));
app.setPath('userData', profile);

app.whenReady().then(async () => {
  let assetRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/landing', 'set-cookie': 'navigation_test=ok; Path=/; HttpOnly; SameSite=Lax' });
      response.end();
    } else if (request.url === '/assets/a.bundle') {
      assetRequests++;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=600' });
      response.end('native cached asset');
    } else if (request.url === '/submit' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => response.end(JSON.stringify({ body, cookiePresent: request.headers.cookie?.includes('navigation_test=ok') })));
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Navigation works</title>Loaded');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const gameSession = session.fromPartition('persist:cache-navigation-test');
  const cache = createGameAssetCache(gameSession, path.join(profile, 'game-assets'));
  const window = new BrowserWindow({ show: false, webPreferences: { session: gameSession, sandbox: true } });
  try {
    await window.loadURL(origin + '/start');
    assert.equal(window.webContents.getURL(), origin + '/landing');
    assert.equal(window.webContents.getTitle(), 'Navigation works');
    const posted = await window.webContents.executeJavaScript(`fetch('/submit', { method: 'POST', body: 'test-post' }).then(r => r.json())`);
    assert.equal(posted.body, 'test-post');
    assert.equal(posted.cookiePresent, true);
    assert.equal(await (await cache.prefetch(origin + '/assets/a.bundle')).text(), 'native cached asset');
    assert.equal(assetRequests, 1);
    const asset = await window.webContents.executeJavaScript(`fetch('/assets/a.bundle').then(r => r.text())`);
    assert.equal(asset, 'native cached asset');
    assert.equal(assetRequests, 1, 'Gameplay should reuse the native cache warmed by prefetch');
    console.log('ELECTRON_NAVIGATION_COOKIE_POST_AND_NATIVE_CACHE_OK');
  } finally {
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
