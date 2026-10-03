const net = require('node:net');
const { randomUUID } = require('node:crypto');

const DISCORD_APPLICATION_ID = '1555289041614807061';
const MAX_PACKET = 64 * 1024;

function encodePacket(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  if (body.length > MAX_PACKET) throw new Error('Discord packet too large');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function activityForPlayer(player, shareName = false) {
  if (!player || !Number.isSafeInteger(player.level) || player.level < 1 || player.level > 2147483647) return null;
  let name = '';
  if (shareName && typeof player.nickname === 'string')
    name = player.nickname.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 48);
  let details = name ? `${name} · Lv. ${player.level}` : `Lv. ${player.level}`;
  // Discord limits rich-presence text. Preserve complete Unicode characters.
  while (Buffer.byteLength(details) > 128) {
    name = Array.from(name).slice(0, -1).join('');
    details = name ? `${name} · Lv. ${player.level}` : `Lv. ${player.level}`;
  }
  let stamina = Number.isSafeInteger(player.stamina) && player.stamina >= 0 && player.stamina <= 2147483647
    ? `Stamina: ${player.stamina}` : 'Stamina unavailable';
  if (player.stamina !== null && player.stamina !== undefined && player.staminaLastRead &&
      Number.isSafeInteger(player.staminaAgeMinutes) && player.staminaAgeMinutes >= 0)
    stamina += ` (last read ${Math.min(player.staminaAgeMinutes, 999)}m ago)`;
  return { details, state: stamina, instance: false };
}

class DiscordPresence {
  constructor({ applicationId = DISCORD_APPLICATION_ID, connect = (path) => net.createConnection(path),
    pid = process.pid, retryMs = 15000, minUpdateMs = 15000, handshakeMs = 3000,
    heartbeatMs = 60000, now = Date.now,
    onStatus = () => {} } = {}) {
    if (!/^\d{17,20}$/.test(applicationId)) throw new Error('Invalid Discord Application ID');
    Object.assign(this, { applicationId, connect, pid, retryMs, minUpdateMs, handshakeMs, heartbeatMs, now, onStatus });
    this.active = false; this.ready = false; this.socket = null;
    this.desired = null; this.sent = undefined; this.lastSentAt = 0;
    this.status = 'Disabled';
  }
  setStatus(status) { this.status = status; this.onStatus(status); }
  start() {
    if (this.active) return;
    this.active = true; this.setStatus('Looking for Discord desktop'); this.open(0);
  }
  open(index) {
    if (!this.active) return;
    if (index >= 10) {
      this.setStatus('Discord desktop not connected; retrying');
      this.retryTimer = setTimeout(() => this.open(0), this.retryMs);
      this.retryTimer.unref?.();
      return;
    }
    let socket;
    try { socket = this.connect(`\\\\?\\pipe\\discord-ipc-${index}`); }
    catch { this.open(index + 1); return; }
    this.socket = socket; this.ready = false;
    let buffer = Buffer.alloc(0), ended = false, connected = false;
    const failed = () => {
      if (ended) return;
      ended = true;
      clearTimeout(this.handshakeTimer); clearTimeout(this.updateTimer); clearTimeout(this.ackTimer);
      clearTimeout(this.keepAliveTimer);
      socket.destroy(); buffer = Buffer.alloc(0);
      if (this.socket !== socket) return;
      this.socket = null; this.ready = false; this.pendingNonce = null; this.sent = undefined;
      if (!this.active) return;
      if (connected) {
        this.setStatus('Discord disconnected; retrying');
        this.retryTimer = setTimeout(() => this.open(0), this.retryMs);
        this.retryTimer.unref?.();
      } else this.open(index + 1);
    };
    socket.once('error', failed); socket.once('close', failed);
    this.handshakeTimer = setTimeout(failed, this.handshakeMs);
    this.handshakeTimer.unref?.();
    socket.once('connect', () => {
      if (!this.active || this.socket !== socket) { failed(); return; }
      try { socket.write(encodePacket(0, { v: 1, client_id: this.applicationId })); } catch { failed(); }
    });
    socket.on('data', (chunk) => {
      if (ended || !this.active) return;
      try {
        if (buffer.length + chunk.length > 2 * MAX_PACKET + 16) { failed(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const op = buffer.readUInt32LE(0), size = buffer.readUInt32LE(4);
          if (size > MAX_PACKET) { failed(); return; }
          if (buffer.length < size + 8) return;
          const data = JSON.parse(buffer.subarray(8, size + 8).toString('utf8'));
          buffer = buffer.subarray(size + 8);
          // READY includes Discord user data; never retain or log that object.
          if (op === 3) socket.write(encodePacket(4, data));
          else if (op === 2) { failed(); return; }
          else if (op === 1 && data.cmd === 'DISPATCH' && data.evt === 'READY') {
            connected = true; this.ready = true; clearTimeout(this.handshakeTimer);
            this.lastSentAt = 0; this.setStatus('Connected; waiting for player data'); this.flush(true);
          } else if (op === 1 && data.nonce === this.pendingNonce) {
            clearTimeout(this.ackTimer); this.pendingNonce = null;
            this.setStatus(data.evt === 'ERROR' ? 'Discord rejected the activity' : this.desired ? 'Activity updated' : 'Connected; waiting for player data');
            this.flush();
          }
        }
      } catch { failed(); }
    });
  }
  setPlayer(player, shareName = false, immediate = false) {
    const next = activityForPlayer(player, shareName);
    if (JSON.stringify(next) === JSON.stringify(this.desired)) { this.flush(); return; }
    this.desired = next;
    // Null clears and privacy changes bypass normal rate limiting.
    this.flush(immediate || !next);
  }
  flush(immediate = false) {
    clearTimeout(this.updateTimer);
    if (!this.active || !this.ready || !this.socket || this.socket.destroyed) return;
    const serialized = JSON.stringify(this.desired);
    const elapsed = this.now() - this.lastSentAt;
    if (serialized === this.sent && (!this.desired || elapsed < this.heartbeatMs)) return;
    const wait = this.minUpdateMs - elapsed;
    if (!immediate && (wait > 0 || this.pendingNonce)) {
      this.updateTimer = setTimeout(() => this.flush(), Math.max(wait, this.pendingNonce ? 250 : 1));
      this.updateTimer.unref?.(); return;
    }
    const nonce = randomUUID();
    const args = this.desired ? { pid: this.pid, activity: this.desired } : { pid: this.pid };
    try {
      this.socket.write(encodePacket(1, { cmd: 'SET_ACTIVITY', args, nonce }));
      this.sent = serialized; this.lastSentAt = this.now(); this.pendingNonce = nonce;
      clearTimeout(this.keepAliveTimer);
      if (this.desired) {
        this.keepAliveTimer = setTimeout(() => this.flush(), this.heartbeatMs);
        this.keepAliveTimer.unref?.();
      }
      clearTimeout(this.ackTimer);
      this.ackTimer = setTimeout(() => { this.socket?.destroy(); }, 5000);
      this.ackTimer.unref?.();
    } catch { this.socket.destroy(); }
  }
  stop() {
    this.active = false;
    clearTimeout(this.retryTimer); clearTimeout(this.handshakeTimer);
    clearTimeout(this.updateTimer); clearTimeout(this.ackTimer);
    clearTimeout(this.keepAliveTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      if (this.ready) {
        try { socket.end(encodePacket(1, { cmd: 'SET_ACTIVITY', args: { pid: this.pid }, nonce: randomUUID() })); }
        catch { socket.destroy(); }
        // end() flushes the clear packet; do not retain an idle pipe during shutdown.
        const timer = setTimeout(() => socket.destroy(), 250); timer.unref?.();
      } else socket.destroy();
    }
    this.ready = false; this.desired = null; this.sent = undefined; this.pendingNonce = null;
    this.setStatus('Disabled');
  }
}

module.exports = { DiscordPresence, activityForPlayer, encodePacket, DISCORD_APPLICATION_ID };
