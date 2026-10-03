// End-to-end local fixtures only. Never connects to the user's Discord or game.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { PlayerStateMonitor } = require('../src/player-state-monitor');
const { PlayerApiFrameDiagnostic } = require('../src/player-api-frame-diagnostic');
const { DiscordPresence, encodePacket, DISCORD_APPLICATION_ID } = require('../src/discord-presence');
const { attachPlayerWindowTitle } = require('../src/player-window-title');
const { scalar, message, initialPlayerReply } = require('./fixtures/player-protobuf.cjs');
const profile = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'criste-presence-test-'));
app.setPath('userData', profile);

const waitFor = async (predicate) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error('Local fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
app.whenReady().then(async () => {
  const pipe = `\\\\?\\pipe\\criste-discord-fixture-${process.pid}`;
  const packets = [], sockets = new Set();
  const ipc = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4) + 8) {
        const op = buffer.readUInt32LE(0), size = buffer.readUInt32LE(4);
        const data = JSON.parse(buffer.subarray(8, size + 8));
        buffer = buffer.subarray(size + 8); packets.push({ op, data });
        if (op === 0) {
          const ready = encodePacket(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'PRIVATE_DISCORD_USER' } } });
          socket.write(ready.subarray(0, 5)); socket.write(ready.subarray(5));
        } else if (op === 1) socket.write(encodePacket(1, { nonce: data.nonce, data: {} }));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => ipc.listen(pipe, resolve));
  let requests = 0;
  let bytes = initialPlayerReply();
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/game/')) {
      requests++; response.writeHead(200, { 'content-type': 'text/plain' }); response.end(bytes);
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/portal' ? '<title>Original game title</title><iframe src="/game"></iframe>' : 'Game fixture');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const title = attachPlayerWindowTitle(window);
  let monitor, diagnostic;
  const presence = new DiscordPresence({ connect: () => net.createConnection(pipe), minUpdateMs: 0 });
  try {
    await window.loadURL(origin + '/portal');
    const game = window.webContents.mainFrame.frames[0];
    const frame = { processId: game.processId, routingId: game.routingId, url: 'https://games.mofushippo.com/game/',
      executeJavaScript(source) {
        source = source.replace("return url.protocol === 'https:' && url.hostname === 'games.mofushippo.com';",
          `return (url.protocol === 'https:' && url.hostname === 'games.mofushippo.com') || url.origin === ${JSON.stringify(origin)};`)
          .replace("['https:', 'wss:']", "['https:', 'wss:', 'http:']");
        return game.executeJavaScript(source);
      } };
    monitor = new PlayerStateMonitor(() => [frame], player => {
      title.setPlayer(player); presence.setPlayer(player, false);
    }, { shareName: true });
    await monitor.start(); presence.start();
    diagnostic = new PlayerApiFrameDiagnostic(() => [frame]);
    await diagnostic.start();
    const result = await game.executeJavaScript(`(async () => {
      const bytes = await (await fetch('/game/?token=PRIVATE_TOKEN')).arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 50));
      return Array.from(new Uint8Array(bytes));
    })()`);
    assert.deepEqual(Buffer.from(result), bytes);
    await monitor.scan();
    await waitFor(() => packets.some(packet => packet.data.args?.activity));
    const activity = packets.find(packet => packet.data.args?.activity).data.args.activity;
    assert.equal(activity.details, 'Lv. 42');
    assert.equal(activity.state, 'Stamina: 120');
    assert.equal(window.getTitle(), 'Original game title | PRIVATE_NAME Level: 42 Stam: 120');
    assert.equal(JSON.stringify(packets).includes('PRIVATE_NAME'), false, 'Local nickname does not imply Discord consent');
    assert.equal(packets[0].data.client_id, DISCORD_APPLICATION_ID);
    assert.equal(JSON.stringify(packets).includes('PRIVATE_TOKEN'), false);
    assert.equal(JSON.stringify(packets).includes('PRIVATE_DISCORD_USER'), false);
    assert.equal(window.webContents.debugger.isAttached(), false);
    assert.equal(await window.webContents.executeJavaScript('typeof window.__cristePresencePlayerReader'), 'undefined');
    bytes = Buffer.concat([scalar(1, 3003), message(3003, scalar(1, 110))]);
    await game.executeJavaScript(`(async () => {
      await fetch('/game/'); await new Promise(resolve => setTimeout(resolve, 50));
    })()`);
    await monitor.scan();
    await waitFor(() => packets.at(-1).data.args?.activity?.state === 'Stamina: 110');
    assert.equal(window.getTitle(), 'Original game title | PRIVATE_NAME Level: 42 Stam: 110');
    const report = await diagnostic.stopAndReport();
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
    presence.setPlayer(monitor.snapshot(), true, true);
    await waitFor(() => packets.at(-1).data.args?.activity?.details === 'PRIVATE_NAME · Lv. 42');
    presence.setPlayer(monitor.snapshot(), false, true);
    await waitFor(() => packets.some(packet => packet.data.args?.activity?.details === 'Lv. 42'));
    monitor.reset();
    assert.equal(window.getTitle(), 'Original game title');
    await waitFor(() => packets.at(-1).data.cmd === 'SET_ACTIVITY' && !packets.at(-1).data.args.activity);
    assert.equal(requests, 2, 'Passive reader must never send extra game requests');
    await monitor.stop();
    assert.equal(await game.executeJavaScript('window.__cristePresencePlayerReader.snapshot().player'), null);
    console.log('ELECTRON_PLAYER_STATE_DISCORD_IPC_PRIVACY_OK');
    console.log('ELECTRON_GAMEPLAY_STAMINA_LOCAL_TITLE_NICKNAME_PRIVACY_OK');
  } finally {
    diagnostic?.finish(); await monitor?.stop(); presence.stop();
    window.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => ipc.close(resolve)), new Promise(resolve => server.close(resolve))]);
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
