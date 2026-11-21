// Run with Electron, not node --test: electron test/region-language.electron.cjs --lang=zh-CN
// Verifies a Simplified Chinese app locale no longer reaches page requests as the first language.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { gameAcceptLanguages } = require('../src/region-cookie');

app.whenReady().then(async () => {
  let header;
  const server = http.createServer((request, response) => {
    header = request.headers['accept-language'];
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.match(app.getLocale(), /^zh-CN$/i, 'run with --lang=zh-CN');
    const ses = session.fromPartition('game-lang');
    ses.setUserAgent(ses.getUserAgent(), gameAcceptLanguages(app.getLocale()));
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    assert.match(header, /^ja-JP,ja;q=/);
    assert.doesNotMatch(header, /zh/i);
    console.log('region language test passed:', header);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    server.close();
  }
});
