const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DiscordPresence, activityForPlayer, encodePacket, DISCORD_APPLICATION_ID } = require('../src/discord-presence');

class Socket extends EventEmitter {
  constructor() { super(); this.packets = []; this.destroyed = false; }
  write(bytes) { this.packets.push({ op: bytes.readUInt32LE(0), data: JSON.parse(bytes.subarray(8).toString()) }); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  end(bytes) { if (bytes) this.write(bytes); this.destroy(); }
}
function fixture(t, options = {}) {
  const paths = [], sockets = [];
  const client = new DiscordPresence({ minUpdateMs: 0, ...options, connect(path) {
    const socket = new Socket(); sockets.push(socket); paths.push(path); return socket;
  } });
  t.after(() => client.stop());
  const ready = () => sockets.at(-1).emit('data', encodePacket(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'PRIVATE_DISCORD_USER' } } }));
  const ack = () => sockets.at(-1).emit('data', encodePacket(1, { nonce: client.pendingNonce, data: {} }));
  return { client, paths, sockets, ready, ack };
}

test('activity allowlist includes level/energy only unless nickname sharing is explicit', () => {
  const player = { level: 96, stamina: 279, nickname: 'PRIVATE_NAME', token: 'PRIVATE_TOKEN', playerId: 'PRIVATE_ID' };
  assert.deepEqual(activityForPlayer(player), { details: 'Lv. 96', state: 'Stamina: 279', instance: false });
  assert.equal(activityForPlayer(player, true).details, 'PRIVATE_NAME · Lv. 96');
  assert.equal(JSON.stringify(activityForPlayer(player, true)).includes('PRIVATE_TOKEN'), false);
  assert.equal(activityForPlayer({ level: 96, stamina: null }).state, 'Stamina unavailable');
  assert.equal(activityForPlayer({ level: 96, stamina: 0 }).state, 'Stamina: 0');
  assert.equal(activityForPlayer({ level: 0, stamina: 999 }), null);
  assert.ok(Buffer.byteLength(activityForPlayer({ level: 96, nickname: 'あ'.repeat(48) }, true).details) <= 128);
});

test('IPC is opt-in, uses local named pipes and the supplied public ID without authentication', (t) => {
  const f = fixture(t);
  assert.equal(f.paths.length, 0);
  f.client.setPlayer({ level: 96, stamina: 279 });
  assert.equal(f.paths.length, 0);
  f.client.start();
  assert.equal(f.paths[0], '\\\\?\\pipe\\discord-ipc-0');
  const socket = f.sockets[0]; socket.emit('connect');
  assert.deepEqual(socket.packets[0], { op: 0, data: { v: 1, client_id: DISCORD_APPLICATION_ID } });
  f.ready();
  assert.equal(socket.packets[1].data.cmd, 'SET_ACTIVITY');
  assert.equal(socket.packets[1].data.args.activity.details, 'Lv. 96');
  assert.equal(socket.packets[1].data.args.activity.state, 'Stamina: 279');
  assert.equal(f.client.user, undefined);
  assert.equal(JSON.stringify(socket.packets).includes('AUTHORIZE'), false);
  assert.equal(JSON.stringify(socket.packets).includes('PRIVATE_'), false);
});

test('IPC decoder tolerates fragmented/coalesced packets and replies to pings', (t) => {
  const f = fixture(t);
  f.client.start(); const socket = f.sockets[0]; socket.emit('connect');
  const bytes = Buffer.concat([encodePacket(1, { cmd: 'DISPATCH', evt: 'READY' }), encodePacket(3, 'ping')]);
  for (const part of [bytes.subarray(0, 3), bytes.subarray(3, 12), bytes.subarray(12)]) socket.emit('data', part);
  assert.equal(f.client.ready, true);
  assert.deepEqual(socket.packets.at(-1), { op: 4, data: 'ping' });
});

test('disabling nickname sharing and presence clears private activity immediately', (t) => {
  const f = fixture(t, { minUpdateMs: 15000 });
  f.client.setPlayer({ level: 96, stamina: 279, nickname: 'PRIVATE_NAME' }, true);
  f.client.start(); const socket = f.sockets[0]; socket.emit('connect'); f.ready();
  assert.equal(socket.packets.at(-1).data.args.activity.details, 'PRIVATE_NAME · Lv. 96');
  f.client.setPlayer({ level: 96, stamina: 279, nickname: 'PRIVATE_NAME' }, false, true);
  assert.equal(socket.packets.at(-1).data.args.activity.details, 'Lv. 96');
  f.client.setPlayer(null, false, true);
  assert.equal(socket.packets.at(-1).data.args.activity, undefined);
  f.client.stop();
  assert.equal(socket.packets.at(-1).data.args.activity, undefined);
  assert.equal(f.client.desired, null);
  assert.equal(f.client.status, 'Disabled');
});

test('updates are deduplicated and rate limited, while latest state replaces pending data', async (t) => {
  const f = fixture(t, { minUpdateMs: 20 });
  f.client.setPlayer({ level: 96, stamina: 279 });
  f.client.start(); const socket = f.sockets[0]; socket.emit('connect'); f.ready(); f.ack();
  const count = socket.packets.length;
  f.client.setPlayer({ level: 96, stamina: 279 });
  assert.equal(socket.packets.length, count);
  f.client.setPlayer({ level: 96, stamina: 278 });
  f.client.setPlayer({ level: 96, stamina: 277 });
  assert.equal(socket.packets.length, count);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(socket.packets.length, count + 1);
  assert.equal(socket.packets.at(-1).data.args.activity.state, 'Stamina: 277');
});

test('missing Discord and malicious packets do not throw or retain arbitrary messages', (t) => {
  const f = fixture(t);
  f.client.start();
  for (let i = 0; i < 10; i++) f.sockets[i].emit('error', new Error('Not running'));
  assert.equal(f.paths.length, 10);
  assert.match(f.client.status, /not connected/);
  f.client.stop();
  f.client.start(); const socket = f.sockets.at(-1); socket.emit('connect');
  const bad = Buffer.alloc(8); bad.writeUInt32LE(1); bad.writeUInt32LE(100000, 4);
  socket.emit('data', bad);
  assert.equal(socket.destroyed, true);
  assert.throws(() => new DiscordPresence({ applicationId: 'PRIVATE_TOKEN' }), /Invalid/);
});

test('unchanged activity is resent every minute and clears immediately on reload or disabling', (t) => {
  let now = 100000;
  const f = fixture(t, { now: () => now });
  const player = { level: 96, stamina: 279 };
  f.client.setPlayer(player); f.client.start();
  const socket = f.sockets[0]; socket.emit('connect'); f.ready(); f.ack();
  const original = socket.packets.at(-1).data.args.activity;
  const count = socket.packets.length;
  now += 59999; f.client.setPlayer(player);
  assert.equal(socket.packets.length, count);
  now++; f.client.setPlayer(player); f.ack();
  assert.equal(socket.packets.length, count + 1);
  assert.deepEqual(socket.packets.at(-1).data.args.activity, original);
  now += 60000; f.client.flush(); f.ack();
  assert.equal(socket.packets.length, count + 2);
  assert.equal(socket.packets.at(-1).data.args.activity.details, 'Lv. 96');
  f.client.setPlayer(null, false, true);
  assert.equal(socket.packets.at(-1).data.args.activity, undefined);
  f.client.stop();
  assert.equal(f.client.keepAliveTimer?._destroyed, true);
});
