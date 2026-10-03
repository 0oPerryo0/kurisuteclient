const { randomUUID } = require('node:crypto');
const { isGameUrl } = require('./player-api-diagnostic');
const { playerStateFrameScript } = require('./player-state-frame');

class PlayerStateMonitor {
  constructor(getFrames, onState, { shareName = false, polling = false, now = Date.now } = {}) {
    this.getFrames = getFrames;
    this.onState = onState;
    this.shareName = shareName;
    this.polling = polling;
    this.now = now;
    this.readerId = randomUUID();
    this.frames = new Map();
    this.retiredDocuments = new Map();
    this.frameRefs = new Map();
    this.refreshState = null;
    this.player = null;
    this.owner = null;
    this.active = false;
  }
  async start() {
    this.active = true;
    await this.scan();
    if (this.active) this.timer = setInterval(() => this.scan().catch(() => {}), 1000);
  }
  async installFrame(frame) {
    if (!this.active || !frame || !isGameUrl(frame.url)) return;
    await frame.executeJavaScript(playerStateFrameScript(this.readerId, this.shareName, this.polling));
  }
  snapshot() {
    if (!this.player) return null;
    const result = { ...this.player };
    // Keep the last verified sample for this document; label its age instead of
    // dropping presence on a timer. Never estimate regeneration from game time.
    const age = Math.max(0, this.now() - result.energyAt);
    if (this.polling || result.lastKnown || age >= 60000) {
      result.staminaLastRead = true;
      result.staminaAgeMinutes = Math.floor(age / 60000);
    }
    if (!this.shareName) result.nickname = null;
    return result;
  }
  reset(retire = true) {
    const frame = this.frameRefs.get(this.owner);
    const documentId = this.frames.get(this.owner)?.documentId;
    if (retire && frame && documentId) frame.executeJavaScript(`(() => {
      const reader = window.__cristePresencePlayerReader;
      if (reader?.readerId === ${JSON.stringify(this.readerId)} && reader.documentId === ${JSON.stringify(documentId)}) reader.pausePolling();
    })()`).catch(() => {});
    if (retire && this.owner && this.frames.get(this.owner)?.documentId)
      this.retiredDocuments.set(this.owner, this.frames.get(this.owner).documentId);
    this.player = null; this.owner = null; this.refreshState = null; this.onState(null);
  }
  async scan() {
    if (!this.active || this.scanning) return;
    this.scanning = (async () => {
      const seen = new Set(), readable = new Set();
      for (const frame of this.getFrames()) {
        if (!this.active) break;
        if (!isGameUrl(frame.url)) continue;
        const key = frame.processId + ':' + frame.routingId;
        seen.add(key);
        this.frameRefs.set(key, frame);
        try {
          await this.installFrame(frame);
          const snapshot = await frame.executeJavaScript(`(() => {
            const reader = window.__cristePresencePlayerReader;
            return reader?.readerId === ${JSON.stringify(this.readerId)} ? reader.snapshot() : null;
          })()`);
          if (!this.active) break;
          readable.add(key);
          const previous = this.frames.get(key);
          this.frames.set(key, snapshot);
          if (snapshot?.documentId === this.retiredDocuments.get(key)) continue;
          this.retiredDocuments.delete(key);
          if (!snapshot || !previous || snapshot.documentId !== previous.documentId || snapshot.revision !== previous.revision) {
            if (snapshot?.player) { this.owner = key; this.player = snapshot.player; this.refreshState = snapshot.refresh; }
            else if (this.owner === key) this.reset(false);
          }
          if (!this.owner && snapshot?.refresh) this.refreshState = snapshot.refresh;
          if (this.owner === key) this.refreshState = snapshot?.refresh;
        } catch {
          if (this.owner === key) this.refreshState = { ...this.refreshState,
            status: 'Game reader unavailable; retaining last-known presence' };
        }
      }
      for (const key of this.frames.keys()) if (!seen.has(key)) {
        if (this.owner === key) this.reset();
        this.frames.delete(key); this.retiredDocuments.delete(key);
        this.frameRefs.delete(key);
      }
      // Only the selected game document may poll; popups/duplicate frames cannot each refresh.
      const ownerFrame = this.frameRefs.get(this.owner);
      if (this.active && this.polling && ownerFrame && readable.has(this.owner) && this.refreshState?.armed &&
          !this.refreshState.busy && this.now() >= this.refreshState.nextPollAt) {
        try { await ownerFrame.executeJavaScript(`(() => {
          const reader = window.__cristePresencePlayerReader;
          if (reader?.readerId === ${JSON.stringify(this.readerId)}) return reader.pollIfDue();
        })()`); } catch { /* The frame may navigate during refresh. */ }
      }
      if (this.active) this.onState(this.snapshot());
    })();
    try { await this.scanning; } finally { this.scanning = null; }
  }
  async stop() {
    this.active = false; clearInterval(this.timer); this.reset();
    await this.scanning?.catch(() => {});
    for (const frame of this.getFrames()) {
      if (!isGameUrl(frame.url)) continue;
      try { await frame.executeJavaScript(`(() => {
        const reader = window.__cristePresencePlayerReader;
        if (reader?.readerId === ${JSON.stringify(this.readerId)}) reader.stop();
      })()`); } catch { /* Frame may already be closed. */ }
    }
    this.frames.clear(); this.retiredDocuments.clear(); this.frameRefs.clear();
  }
}

module.exports = { PlayerStateMonitor };
