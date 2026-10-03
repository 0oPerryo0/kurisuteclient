const { randomUUID } = require('node:crypto');
const { isGameUrl } = require('./player-api-diagnostic');
const { playerApiFrameScript } = require('./player-api-frame-script');

class PlayerApiFrameDiagnostic {
  constructor(getFrames, onStopped = () => {}) {
    this.getFrames = getFrames;
    this.onStopped = onStopped;
    this.captureId = randomUUID();
    this.active = false;
    this.frames = new Map();
    this.installations = new Set();
    this.responses = [];
    this.observedEndpoints = new Map();
    this.sockets = new Map();
    this.counts = { gameRequests: 0, requestsSeen: 0, webSocketFramesSeen: 0, frameReadFailures: 0 };
  }
  async start() {
    this.active = true;
    this.startedAt = new Date().toISOString();
    try { await this.scan(); } catch (error) { this.finish('setup-error'); throw error; }
    this.pollTimer = setInterval(() => this.scan().catch(() => { this.counts.frameReadFailures++; }), 1000);
    this.timer = setTimeout(() => this.finish('timeout'), 180000);
  }
  async installFrame(frame) {
    if (!this.active || !frame || !isGameUrl(frame.url)) return;
    const key = frame.processId + ':' + frame.routingId;
    try {
      const installation = frame.executeJavaScript(playerApiFrameScript(this.captureId));
      this.installations.add(installation);
      let result;
      try { result = await installation; } finally { this.installations.delete(installation); }
      if (result?.installed) this.frames.set(key, { frame, hooks: result.hooks, observerVersion: result.observerVersion });
    } catch { this.counts.frameReadFailures++; }
  }
  collect(report) {
    if (!report || typeof report !== 'object') return;
    for (const [key, value] of Object.entries(report.counts || {}))
      if (/^[A-Za-z]+$/.test(key) && Number.isSafeInteger(value) && value >= 0)
        this.counts[key] = (this.counts[key] || 0) + value;
    for (const response of report.responses || []) if (this.responses.length < 100) this.responses.push(response);
    for (const entry of report.observedApiEndpoints || []) {
      const key = JSON.stringify(entry);
      if (this.observedEndpoints.has(key)) this.observedEndpoints.get(key).count++;
      else if (this.observedEndpoints.size < 60) this.observedEndpoints.set(key, { ...entry, count: 1 });
    }
    for (const socket of report.webSocketTransports || []) {
      const key = socket.endpoint || 'unknown';
      if (!this.sockets.has(key) && this.sockets.size < 20) this.sockets.set(key, { ...socket, receivedFrames: 0, textFrames: 0, binaryFrames: 0 });
      const entry = this.sockets.get(key);
      if (entry) for (const count of ['receivedFrames', 'textFrames', 'binaryFrames']) entry[count] += socket[count] || 0;
    }
  }
  reportScript(stop = false) {
    return `(${stop ? 'async ' : ''}() => { const watch = window.__cristePlayerApiCapture;
      if (!watch || watch.captureId !== ${JSON.stringify(this.captureId)}) return null;
      ${stop ? 'await Promise.race([watch.whenIdle?.(), new Promise(resolve => setTimeout(resolve, 500))]); watch.stop();' : ''}
      return watch.takeReport(); })()`;
  }
  async scan() {
    if (!this.active || this.scanTask) return;
    this.scanTask = (async () => {
      for (const frame of this.getFrames()) {
        if (!this.active) break;
        if (!isGameUrl(frame.url)) continue;
        await this.installFrame(frame);
        try { this.collect(await frame.executeJavaScript(this.reportScript())); }
        catch { this.counts.frameReadFailures++; }
      }
    })();
    try { await this.scanTask; } finally { this.scanTask = null; }
  }
  finish(reason = 'manual') {
    if (this.stopTask) return;
    const wasActive = this.active;
    this.active = false;
    this.stoppedReason ||= reason;
    clearInterval(this.pollTimer); clearTimeout(this.timer);
    this.stopTask = (async () => {
      await this.scanTask?.catch(() => {});
      await Promise.allSettled([...this.installations]);
      let frames = [];
      try { frames = this.getFrames(); } catch { this.counts.frameReadFailures++; }
      for (const frame of frames) {
        if (!isGameUrl(frame.url)) continue;
        try { this.collect(await frame.executeJavaScript(this.reportScript(true))); }
        catch { this.counts.frameReadFailures++; }
      }
    })();
    if (wasActive) this.onStopped();
  }
  async stopAndReport() {
    this.finish();
    await this.stopTask;
    return { diagnosticVersion: 8, captureMode: 'game-frame-observer', startedAt: this.startedAt,
      finishedAt: new Date().toISOString(), stoppedReason: this.stoppedReason,
      note: 'Passive browser API wrappers, without debugger attachment, request replay or Unity memory writes. Only game-origin HTTP bodies are summarized. Reviewed HotUpdate.dll protobuf paths for InitGameDataSc, UpdateEnergySC and stage-start responses expose only player level/energy numeric samples and nickname presence. Successful gameplay envelopes expose only a static event label. All other protobuf scalar values and byte/string contents are omitted. Account-name values, tokens, IDs, query strings and raw bodies are never saved. No encryption keys are read or guessed. Mapping remains unverified against the game display; this diagnostic sends no Discord presence.',
      gameFramesAttached: this.frames.size, installedHooks: [...this.frames.values()].map((entry) => entry.hooks).filter(Boolean),
      installedObserverVersions: [...new Set([...this.frames.values()].map((entry) => entry.observerVersion))],
      counts: this.counts, responses: this.responses, observedApiEndpoints: [...this.observedEndpoints.values()],
      webSocketTransports: [...this.sockets.values()] };
  }
}

module.exports = { PlayerApiFrameDiagnostic };
