const { playerApiWireHelpersScript } = require('./player-api-wire');
const { isPlayerRefreshRequest } = require('./player-refresh-request');

function playerStateFrameScript(readerId, shareName = false, polling = false) {
  return `(() => {
    ${playerApiWireHelpersScript()}
    ${isPlayerRefreshRequest.toString()}
    if (!isGameUrl(location.href)) return { installed: false };
    const key = '__cristePresencePlayerReader', readerId = ${JSON.stringify(readerId)};
    const shareName = ${shareName === true};
    const polling = ${polling === true}, interval = 60 * 1000;
    if (window[key]?.readerId === readerId && window[key].active()) return { installed: true };
    window[key]?.stop();
    const documentId = Math.random().toString(36).slice(2);
    let active = true, reading = 0, state = null, revision = 0, issued = 0, applied = 0;
    const readers = new Set();
    const nativeFetch = window.fetch, prototype = window.XMLHttpRequest?.prototype, nativeSend = prototype?.send;
    let template = null, pollController = null, failures = 0, nextPollAt = 0, preparing = 0, sessionEpoch = 0;
    let gameplayRefreshAt = 0, lastRefreshAt = 0, backoffUntil = 0, gameplayRevision = 0;
    let refreshStatus = polling ? 'Reload to observe an InitGameDataCs request' : 'Disabled';
    const requestReaders = new Set();
    const pausePolling = () => {
      sessionEpoch++;
      template = null; nextPollAt = 0; gameplayRefreshAt = 0; backoffUntil = 0;
      pollController?.abort(); pollController = null;
      refreshStatus = polling ? 'Paused; reload to observe a new request' : 'Disabled';
    };
    const boundedBytes = async (body, maximum, set) => {
      const reader = body?.getReader();
      if (!reader) throw new Error('No body');
      set.add(reader);
      try {
        const chunks = []; let size = 0;
        while (active) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maximum) throw new Error('Body limit');
          chunks.push(value);
        }
        if (!active) throw new Error('Stopped');
        const bytes = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        return bytes;
      } finally { set.delete(reader); reader.cancel().catch(() => {}); }
    };
    const prepareTemplate = async (input, init) => {
      if (!polling || !active || preparing >= 2 || typeof Request !== 'function') return null;
      let request;
      const epoch = sessionEpoch;
      try {
        // A bare stream in RequestInit cannot be cloned without taking over the game's body.
        if (typeof init?.body?.getReader === 'function') return null;
        const bodySize = typeof init?.body === 'string' ? init.body.length : init?.body?.byteLength ?? init?.body?.size ?? 0;
        if (bodySize > 8192) return null;
        const url = typeof input === 'string' || input instanceof URL ? new URL(String(input), location.href).href : input?.url;
        if (!isGameApiEndpoint(url)) return null;
        // clone before the game consumes a Request input; never consume its original body.
        const source = input instanceof Request ? input.clone() : url;
        request = new Request(source, init);
        if (request.method !== 'POST' || Number(request.headers.get('content-length') || 0) > 8192) return null;
      } catch { return null; }
      preparing++;
      try {
        const bytes = await boundedBytes(request.body, 8192, requestReaders);
        if (!isPlayerRefreshRequest(bytes)) return null;
        return { epoch, url: request.url, method: 'POST', headers: new Headers(request.headers),
          credentials: request.credentials, body: bytes };
      } catch { return null; }
      finally { preparing--; }
    };
    const arm = (candidate, player) => {
      if (!active || !polling || !candidate || candidate.epoch !== sessionEpoch || !player?.initial || !Number.isSafeInteger(player.level) ||
          !Number.isSafeInteger(player.stamina)) return;
      // Hold only in this frame's closure: never send headers, body or URL to main/reports.
      template = candidate; failures = 0; nextPollAt = Date.now() + interval;
      gameplayRefreshAt = 0; backoffUntil = 0;
      refreshStatus = 'Ready; refresh every minute'; revision++;
    };
    const accept = (player) => {
      if (!active) return;
      if (player.initial) state = { level: player.level ?? null, stamina: player.stamina ?? null,
        nickname: shareName ? player.nickname || null : null, initializedAt: Date.now(), energyAt: Date.now() };
      else if (state && player.stamina !== undefined) {
        state.stamina = player.stamina; state.energyAt = Date.now(); state.lastKnown = false;
      }
      if (state) revision++;
    };
    const invalidate = (sequence) => {
      if (!active || sequence < applied) return;
      applied = sequence;
      if (state) {
        // Unknown responses cannot replace a verified sample. Keep it labelled as
        // last known until a supported update, navigation, logout or disabling.
        state.lastKnown = true; revision++;
      }
    };
    const queueGameplayRefresh = (event) => {
      if (!active || !polling || !template || !state) return;
      // Coalesce a burst, allow only one in-flight request, and never bypass a
      // server's Retry-After/backoff. Only the owning frame calls pollIfDue().
      const due = Math.max(Date.now() + 1000, lastRefreshAt + 15000, backoffUntil);
      gameplayRefreshAt = gameplayRefreshAt ? Math.min(gameplayRefreshAt, due) : due;
      gameplayRevision++;
      if (!pollController) refreshStatus = 'Gameplay observed (' + event + '); refresh queued';
      revision++;
    };
    const consume = async (bytes, sequence) => {
      if (!active || bytes.byteLength > MAX_BODY) return;
      let player;
      const summary = await summarizePlayerWire(bytes, (value) => { player = value; }, shareName);
      if (!active || sequence < applied) return;
      if (player) { applied = sequence; accept(player); return player; }
      const tags = summary.wire?.protobufCandidate?.fields.filter(field => field.number >= 10).map(field => field.number) || [];
      if (tags.some(tag => tag === 11 || tag === 15)) { pausePolling(); applied = sequence; state = null; revision++; return; }
      if (summary.wire?.responseMeta?.hasError) {
        pausePolling(); refreshStatus = 'Game reported an error; reload required';
        applied = sequence; if (state) state.lastKnown = true; revision++; return;
      }
      if (summary.wire?.responseMeta?.gameplay) queueGameplayRefresh(summary.wire.responseMeta.gameplay);
      // Unknown actions may alter the profile: retain only a labelled last-known sample.
      const readOnly = [17, 1024, 1050, 1060, 1062, 1064];
      if (!tags.length || tags.some(tag => !readOnly.includes(tag))) {
        invalidate(sequence);
      }
    };
    const inspectFetch = async (response, candidate) => {
      if (!active || !isGameApiEndpoint(response.url)) return;
      const sequence = ++issued;
      if (!response.ok || reading >= 2 || Number(response.headers.get('content-length') || 0) > MAX_BODY) {
        if (response.status === 401 || response.status === 403) { pausePolling(); refreshStatus = 'Authentication expired; reload required'; state = null; revision++; }
        invalidate(sequence); return;
      }
      reading++;
      let reader;
      try {
        reader = response.clone().body?.getReader();
        if (!reader) { invalidate(sequence); return; }
        readers.add(reader);
        const chunks = []; let size = 0;
        while (active) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) { invalidate(sequence); return; }
          chunks.push(value);
        }
        if (!active) return;
        const bytes = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        const player = await consume(bytes, sequence);
        arm(await candidate, player);
      } catch { invalidate(sequence); /* Never log response data. */ }
      finally { reading--; if (reader) { readers.delete(reader); reader.cancel().catch(() => {}); } }
    };
    const fetch = typeof nativeFetch === 'function' ? function(...args) {
      const candidate = polling ? prepareTemplate(args[0], args[1]) : null;
      const promise = Reflect.apply(nativeFetch, this, args);
      if (active) promise.then(response => inspectFetch(response, candidate), () => {}).catch(() => {});
      return promise;
    } : undefined;
    const nativeOpen = prototype?.open, nativeHeader = prototype?.setRequestHeader;
    const xhrRequests = new WeakMap();
    const open = typeof nativeOpen === 'function' ? function(method, url, ...args) {
      const result = Reflect.apply(nativeOpen, this, [method, url, ...args]);
      if (polling) xhrRequests.set(this, { method, url, headers: [] });
      return result;
    } : undefined;
    const header = typeof nativeHeader === 'function' ? function(name, value) {
      const result = Reflect.apply(nativeHeader, this, [name, value]);
      const entry = xhrRequests.get(this);
      if (entry && entry.headers.length < 40) entry.headers.push([name, value]);
      return result;
    } : undefined;
    const send = typeof nativeSend === 'function' ? function(...args) {
      const entry = xhrRequests.get(this);
      let candidate = null;
      try {
        if (entry && polling) candidate = prepareTemplate(new URL(entry.url, location.href).href, {
          method: entry.method, headers: entry.headers, body: args[0], credentials: this.withCredentials ? 'include' : 'same-origin',
        });
      } catch { /* Metadata capture must not prevent the original XHR send. */ }
      if (active) this.addEventListener('loadend', () => {
        if (!active || !isGameApiEndpoint(this.responseURL)) return;
        const sequence = ++issued;
        if (this.status < 200 || this.status >= 300 || reading >= 2) {
          if (this.status === 401 || this.status === 403) { pausePolling(); refreshStatus = 'Authentication expired; reload required'; state = null; revision++; }
          invalidate(sequence); return;
        }
        try {
          let bytes;
          if (this.responseType === 'arraybuffer') bytes = new Uint8Array(this.response || new ArrayBuffer(0));
          else if (this.responseType === '' || this.responseType === 'text') {
            if (this.responseText.length > MAX_BODY) { invalidate(sequence); return; }
            bytes = new TextEncoder().encode(this.responseText);
          } else { invalidate(sequence); return; }
          if (bytes.byteLength > MAX_BODY) { invalidate(sequence); return; }
          reading++;
          consume(bytes, sequence).then(async player => arm(await candidate, player))
            .catch(() => { invalidate(sequence); }).finally(() => { reading--; });
        } catch { invalidate(sequence); }
      }, { once: true });
      return Reflect.apply(nativeSend, this, args);
    } : undefined;
    if (fetch) window.fetch = fetch;
    if (send) prototype.send = send;
    if (polling && open) prototype.open = open;
    if (polling && header) prototype.setRequestHeader = header;
    const pollIfDue = async () => {
      const due = Math.min(nextPollAt, gameplayRefreshAt || Infinity);
      if (!active || !polling || !template || !state || pollController || Date.now() < due || preparing || reading) return;
      const controller = pollController = new AbortController(), sequence = ++issued;
      const gameplay = !!gameplayRefreshAt && Date.now() >= gameplayRefreshAt;
      const pendingGameplayRevision = gameplayRevision;
      gameplayRefreshAt = 0; lastRefreshAt = Date.now();
      const timeout = setTimeout(() => controller.abort(), 15000);
      nextPollAt = Date.now() + interval; refreshStatus = 'Refreshing player data';
      reading++;
      let response;
      try {
        const current = template;
        // Use the existing transport, not the wrapper: cannot arm recursively or call Unity.
        response = await Reflect.apply(nativeFetch, window, [current.url, {
          method: current.method, body: current.body, headers: new Headers(current.headers),
          credentials: current.credentials, redirect: 'error', cache: 'no-store', signal: controller.signal,
        }]);
        if (!active || controller.signal.aborted || pollController !== controller) return;
        if (response.status === 401 || response.status === 403) {
          pausePolling(); refreshStatus = 'Authentication expired; reload required'; state = null; revision++; return;
        }
        if (!response.ok) {
          if (response.status !== 429 && response.status < 500) { pausePolling(); refreshStatus = 'Request rejected; reload required'; return; }
          throw new Error('Temporary failure');
        }
        if (!isGameApiEndpoint(response.url) || Number(response.headers.get('content-length') || 0) > MAX_BODY)
          throw new Error('Unexpected response');
        const bytes = await boundedBytes(response.body, MAX_BODY, readers);
        if (!active || controller.signal.aborted || pollController !== controller) return;
        let player;
        await summarizePlayerWire(bytes, value => { player = value; }, shareName);
        if (!player?.initial || !Number.isSafeInteger(player.level) || !Number.isSafeInteger(player.stamina)) {
          pausePolling(); refreshStatus = 'Player response not recognized; reload required';
          if (state) state.lastKnown = true; revision++; return;
        }
        if (!active || pollController !== controller || controller.signal.aborted) return;
        if (sequence >= applied) { applied = sequence; accept(player); }
        failures = 0; backoffUntil = 0;
        if (gameplayRevision === pendingGameplayRevision) gameplayRefreshAt = 0;
        refreshStatus = gameplay ? 'Last gameplay refresh succeeded' : 'Last refresh succeeded';
      } catch {
        if (!active || pollController !== controller) return;
        failures++;
        const retry = response?.headers.get('retry-after');
        const seconds = retry && /^\\d+$/.test(retry) ? Number(retry) : 0;
        const date = retry && !seconds ? Date.parse(retry) : NaN;
        const retryMs = seconds ? Math.min(seconds, 86400) * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
        nextPollAt = Date.now() + Math.max(interval * 2 ** Math.min(failures, 4), retryMs);
        backoffUntil = nextPollAt;
        if (gameplayRefreshAt) gameplayRefreshAt = Math.max(gameplayRefreshAt, backoffUntil);
        refreshStatus = 'Refresh failed; backing off';
      } finally {
        clearTimeout(timeout); reading--;
        if (pollController === controller) pollController = null;
        revision++;
      }
    };
    const stop = () => {
      active = false; state = null; revision++;
      pausePolling();
      window.removeEventListener?.('pagehide', stop);
      if (window.fetch === fetch) window.fetch = nativeFetch;
      if (prototype?.send === send) prototype.send = nativeSend;
      if (prototype?.open === open) prototype.open = nativeOpen;
      if (prototype?.setRequestHeader === header) prototype.setRequestHeader = nativeHeader;
      for (const reader of readers) reader.cancel().catch(() => {});
      readers.clear();
      for (const reader of requestReaders) reader.cancel().catch(() => {});
      requestReaders.clear();
    };
    window.addEventListener?.('pagehide', stop, { once: true });
    Object.defineProperty(window, key, { configurable: true, value: {
      readerId, documentId, active: () => active, stop, pausePolling, pollIfDue,
      snapshot: () => ({ documentId, revision, player: state ? { ...state } : null,
        refresh: { enabled: polling, armed: !!template, busy: !!pollController,
          nextPollAt: template ? Math.min(nextPollAt, gameplayRefreshAt || Infinity) : 0,
          gameplayPending: !!gameplayRefreshAt, failures, status: refreshStatus } }),
    } });
    return { installed: true };
  })()`;
}

module.exports = { playerStateFrameScript };
