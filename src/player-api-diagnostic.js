// Observe existing game responses through CDP. Never intercept or replay requests.
const MAX_BODY = 512 * 1024;
const MAX_RESPONSES = 100;
const SECRET_KEY = /token|auth|cookie|session|password|secret|(?:user|account|player|platform)[_-]?id|email|address|phone|payment|receipt/i;
const ROUTE_PARTS = /^(?:api|rpc|rest|game|player|user|account|profile|info|data|login|logout|status|stamina|energy|home|start|update|refresh|level|rank|battle|result|get|post|websocket|ws|getuserinfo|getplayerinfo|getprofile|playerinfo|userinfo|v\d{1,2})$/i;

function isGameUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'games.mofushippo.com'; }
  catch { return false; }
}

function isGameScriptUrl(value) {
  return isGameUrl(value) || (typeof value === 'string' && value.startsWith('blob:') && isGameUrl(value.slice(5)));
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password) return null;
    // Only known route words survive: unknown segments can be names or tokens.
    const segments = url.pathname.split('/').filter(Boolean).slice(0, 12).map((part) => {
      if (!ROUTE_PARTS.test(part)) return '<redacted>';
      return part;
    });
    return url.origin + '/' + segments.join('/');
  } catch { return null; }
}

function summarizePlayerJson(text) {
  if (text.length > MAX_BODY || new TextEncoder().encode(text).byteLength > MAX_BODY)
    return { format: 'oversized', fields: [], candidates: [] };
  let data;
  try { data = JSON.parse(text); } catch { return { format: 'non-json', fields: [], candidates: [] }; }
  return summarizePlayerData(data);
}

function summarizePlayerData(data) {
  const fields = [], candidates = [];
  let visited = 0;
  const walk = (value, route, depth) => {
    if (++visited > 2000 || depth > 12 || fields.length >= 250) return;
    if (Array.isArray(value)) {
      fields.push({ path: route, type: 'array' });
      // One element gives a schema without accumulating other players' data.
      if (value.length) walk(value[0], route + '[0]', depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || SECRET_KEY.test(key)) continue;
        const path = route + '.' + key;
        if (item && typeof item === 'object') { walk(item, path, depth + 1); continue; }
        const type = item === null ? 'null' : typeof item;
        fields.push({ path, type });
        const normal = key.replace(/_/g, '').toLowerCase();
        let category;
        if (/^(?:username|playername|accountname|nickname|rolename|displayname)$/.test(normal) ||
            (normal === 'name' && /(?:player|user|account|profile|role)(?:info|data)?(?:\.|\[)/i.test(path))) category = 'accountName';
        else if (/^(?:(?:player|user|account|role)?(?:level|lv)|rank)$/.test(normal)) category = 'level';
        else if (/^(?:(?:current|cur|now|max|maximum)?(?:stamina|energy|ap|vigor|vitality|physicalpower)|(?:stamina|energy|ap|vigor|vitality|physicalpower)(?:current|cur|now|max|maximum|limit))$/.test(normal)) category = 'stamina';
        else if (/^(?:value|current|cur|now|max|maximum|limit)$/.test(normal) &&
            /(?:\.(?:stamina|energy|ap|vigor|vitality|physicalpower)(?:info|data)?)(?:\.|\[)/i.test(path)) category = 'stamina';
        if (category) {
          const candidate = { path, category, type };
          const numeric = typeof item === 'number' ? item : typeof item === 'string' && /^\d{1,9}$/.test(item) ? Number(item) : NaN;
          if (category !== 'accountName' && Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1000000000)
            candidate.sample = numeric;
          else candidate.valueOmitted = true;
          candidates.push(candidate);
        }
        if (fields.length >= 250) break;
      }
    }
  };
  walk(data, '$', 0);
  return { format: 'json', fields, candidates,
    note: 'Candidate names only; unit levels, other players and currencies may match. Validate against the in-game profile and stamina display.' };
}

function playerApiHelpersScript() {
  return `const MAX_BODY = ${MAX_BODY}; const SECRET_KEY = ${SECRET_KEY}; const ROUTE_PARTS = ${ROUTE_PARTS};
    ${isGameUrl.toString()} ${safeEndpoint.toString()} ${summarizePlayerData.toString()} ${summarizePlayerJson.toString()}`;
}

class PlayerApiDiagnostic {
  constructor(contents, onStopped = () => {}) {
    this.contents = contents;
    this.onStopped = onStopped;
    this.debugger = contents.debugger;
    this.frames = new Map();
    this.frameSnapshots = new Map();
    this.requests = new Map();
    this.observedEndpoints = new Map();
    this.pending = new Map();
    this.tasks = new Set();
    this.responses = [];
    this.webSockets = new Map();
    this.setupWarnings = ['Worker and child-target attachment is disabled for stability; their traffic may be missing.'];
    this.counts = { skippedLarge: 0, bodyUnavailable: 0, responseLimit: 0,
      requestsSeen: 0, responsesSeen: 0, gameRequests: 0, apiResponsesSeen: 0,
      ignoredScope: 0, staticSkipped: 0, nonSuccess: 0, loadingFailed: 0,
      webSocketFramesSeen: 0, childEventsIgnored: 0, bodyReadsSkippedBusy: 0, captureErrors: 0 };
    this.active = false;
    this.attached = false;
    this.message = (_event, method, params, sessionId) => {
      try { this.handle(method, params, sessionId); }
      catch { this.counts.captureErrors++; this.finish('capture-error'); }
    };
    this.detached = () => { this.attached = false; this.finish('debugger-detached'); };
    this.destroyed = () => this.finish('window-closed');
  }
  async start() {
    if (this.debugger.isAttached()) throw new Error('Close game DevTools before starting the API capture');
    try {
      this.debugger.attach('1.3');
      this.attached = true;
      this.active = true;
      this.startedAt = new Date().toISOString();
      this.debugger.on('message', this.message);
      this.debugger.on('detach', this.detached);
      this.contents.once('destroyed', this.destroyed);
      await this.debugger.sendCommand('Page.enable');
      const tree = await this.debugger.sendCommand('Page.getFrameTree');
      this.rememberTree(tree.frameTree);
      await this.enableNetwork();
      this.timer = setTimeout(() => this.finish('timeout'), 180000);
    } catch (error) { this.finish('setup-error'); throw error; }
  }
  key(id, sessionId = '') { return sessionId + ':' + id; }
  rememberFrame(frame, sessionId) {
    const game = isGameUrl(frame.url);
    this.frames.set(this.key(frame.id, sessionId), { game });
    const snapshot = { endpoint: safeEndpoint(frame.url), game };
    const key = JSON.stringify(snapshot);
    if (this.frameSnapshots.size < 30) this.frameSnapshots.set(key, snapshot);
  }
  rememberTree(node, sessionId) {
    this.rememberFrame(node.frame, sessionId);
    for (const child of node.childFrames || []) this.rememberTree(child, sessionId);
  }
  enableNetwork() {
    // Bound additional buffering beside Unity's large WASM heap. Do not auto-attach
    // to workers or OOPIFs: the native target lifecycle may destabilize a live game.
    return this.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 4 * MAX_BODY, maxResourceBufferSize: MAX_BODY });
  }
  track(task) {
    const pending = task.catch(() => { this.counts.captureErrors++; }).finally(() => this.tasks.delete(pending));
    this.tasks.add(pending);
  }
  gameFrame(id, sessionId) {
    // A game iframe's third-party children are not automatically trusted.
    return this.frames.get(this.key(id, sessionId))?.game === true;
  }
  gameInitiator(initiator) {
    if (isGameScriptUrl(initiator?.url)) return true;
    let stack = initiator?.stack;
    for (let i = 0; stack && i < 8; i++, stack = stack.parent)
      if (stack.callFrames?.some((frame) => isGameScriptUrl(frame.url))) return true;
    return false;
  }
  observeEndpoint(response, type, scoped) {
    const endpoint = safeEndpoint(response.url);
    if (!endpoint) return;
    const entry = { endpoint, type, gameScoped: scoped, status: response.status,
      mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(response.mimeType) ? response.mimeType : 'unknown' };
    const key = JSON.stringify(entry);
    if (this.observedEndpoints.has(key)) this.observedEndpoints.get(key).count++;
    else if (this.observedEndpoints.size < 60) this.observedEndpoints.set(key, { ...entry, count: 1 });
  }
  handle(method, params, sessionId) {
    if (!this.active) return;
    if (sessionId) { this.counts.childEventsIgnored++; return; }
    const requestKey = this.key(params.requestId, sessionId);
    if (method === 'Page.frameNavigated') {
      this.rememberFrame(params.frame, sessionId);
    } else if (method === 'Page.frameDetached') {
      this.frames.delete(this.key(params.frameId, sessionId));
    } else if (method === 'Network.requestWillBeSent') {
      this.counts.requestsSeen++;
      const scoped = this.gameFrame(params.frameId, sessionId) || this.gameInitiator(params.initiator) ||
        isGameUrl(params.documentURL);
      if (scoped) this.counts.gameRequests++;
      if (this.requests.size < 2000 || this.requests.has(requestKey)) this.requests.set(requestKey, scoped);
      // No request URL, post body, headers or credentials are retained.
    } else if (method === 'Network.responseReceived') {
      const response = params.response;
      this.counts.responsesSeen++;
      if (!['XHR', 'Fetch', 'Other'].includes(params.type)) return;
      this.counts.apiResponsesSeen++;
      const scoped = this.gameFrame(params.frameId, sessionId) || this.requests.get(requestKey) === true;
      this.observeEndpoint(response, params.type, scoped);
      if (!scoped) { this.counts.ignoredScope++; return; }
      if (response.status !== 200) { this.counts.nonSuccess++; return; }
      const endpoint = safeEndpoint(response.url);
      if (!endpoint) return;
      // Ignore static Unity downloads so a reload cannot exhaust the API limit.
      try { if (/\.(?:bundle|unityweb|wasm|data|bytes|js|css|json|br|gz|png|jpg|webp)$/i.test(new URL(response.url).pathname) &&
          !/json/i.test(response.mimeType)) { this.counts.staticSkipped++; return; } } catch { return; }
      if (this.responses.length + this.tasks.size + this.pending.size >= MAX_RESPONSES) { this.counts.responseLimit++; return; }
      const length = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
      if (Number(length) > MAX_BODY) { this.counts.skippedLarge++; return; }
      // Headers and full URLs are deliberately discarded here.
      this.pending.set(requestKey, { endpoint, mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(response.mimeType) ? response.mimeType : 'unknown' });
    } else if (method === 'Network.loadingFailed') {
      this.counts.loadingFailed++;
      this.pending.delete(requestKey);
      this.requests.delete(requestKey);
    } else if (method === 'Network.loadingFinished') {
      const entry = this.pending.get(requestKey);
      this.pending.delete(requestKey);
      this.requests.delete(requestKey);
      if (!entry) return;
      if (params.encodedDataLength > MAX_BODY) { this.counts.skippedLarge++; return; }
      if (!/json|^text\//i.test(entry.mimeType)) {
        this.responses.push({ ...entry, format: 'not-read', fields: [], candidates: [],
          note: 'Non-text response; body was not read.' });
        return;
      }
      if (this.tasks.size >= 2) { this.counts.bodyReadsSkippedBusy++; return; }
      this.track(this.readBody(params.requestId, entry, sessionId));
    } else if (method === 'Network.webSocketCreated') {
      const endpoint = safeEndpoint(params.url);
      if (endpoint && this.webSockets.size < 20) this.webSockets.set(requestKey, {
        endpoint, gameScoped: this.gameInitiator(params.initiator),
        receivedFrames: 0, sentFrames: 0, textFrames: 0, binaryFrames: 0,
      });
    } else if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
      this.counts.webSocketFramesSeen++;
      if (!this.webSockets.has(requestKey) && this.webSockets.size < 20) this.webSockets.set(requestKey, {
        endpoint: null, gameScoped: null,
        note: 'Connection was not created during capture; source may be unknown.',
        receivedFrames: 0, sentFrames: 0, textFrames: 0, binaryFrames: 0,
      });
      const socket = this.webSockets.get(requestKey);
      if (socket) {
        socket[method.endsWith('Received') ? 'receivedFrames' : 'sentFrames']++;
        if (params.response.opcode === 1) socket.textFrames++;
        if (params.response.opcode === 2) socket.binaryFrames++;
      }
      // Do not inspect or retain payloadData, including authentication messages.
    }
  }
  async readBody(requestId, entry, sessionId) {
    try {
      // Electron emits an empty string for the root session but rejects it in sendCommand.
      const response = await this.debugger.sendCommand('Network.getResponseBody', { requestId }, sessionId || undefined);
      if (response.body.length > MAX_BODY * (response.base64Encoded ? 4 / 3 : 1)) { this.counts.skippedLarge++; return; }
      const text = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      const summary = summarizePlayerJson(text);
      // Persist only schema and approved numeric samples, not the response itself.
      if (this.responses.length < MAX_RESPONSES) this.responses.push({ ...entry, ...summary });
    } catch { this.counts.bodyUnavailable++; }
  }
  finish(reason = 'manual') {
    const wasActive = this.active;
    this.active = false;
    this.stoppedReason ||= reason;
    clearTimeout(this.timer);
    this.pending.clear();
    this.requests.clear();
    this.debugger.removeListener('message', this.message);
    this.debugger.removeListener('detach', this.detached);
    this.contents.removeListener('destroyed', this.destroyed);
    if (this.attached) {
      try { if (this.debugger.isAttached()) this.debugger.detach(); }
      catch { /* A crashed renderer may already be gone. */ }
    }
    this.attached = false;
    if (wasActive) this.onStopped();
  }
  async stopAndReport() {
    // Stop accepting responses, but let already-requested bodies finish before detaching.
    this.active = false;
    clearTimeout(this.timer);
    await Promise.all([...this.tasks]);
    this.finish();
    return { diagnosticVersion: 3, captureMode: 'root-only', startedAt: this.startedAt, finishedAt: new Date().toISOString(), stoppedReason: this.stoppedReason,
      note: 'Read-only observation of existing game API responses. Frame and endpoint metadata includes out-of-scope traffic for capture-health diagnosis, but its bodies are not read. No requests replayed. Account-name values, IDs, cookies, tokens, query strings and raw bodies are omitted. Numeric samples are unverified candidates. WebSocket payloads were not inspected.',
      counts: this.counts, setupWarnings: this.setupWarnings, frameSnapshots: [...this.frameSnapshots.values()],
      observedApiEndpoints: [...this.observedEndpoints.values()], responses: this.responses,
      webSocketEndpoints: [...new Set([...this.webSockets.values()].filter((socket) => socket.gameScoped).map((socket) => socket.endpoint).filter(Boolean))],
      webSocketTransports: [...this.webSockets.values()] };
  }
}

module.exports = { PlayerApiDiagnostic, summarizePlayerJson, summarizePlayerData, playerApiHelpersScript, safeEndpoint, isGameUrl };
