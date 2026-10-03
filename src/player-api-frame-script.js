const { playerApiWireHelpersScript } = require('./player-api-wire');

function playerApiFrameScript(captureId) {
  return `(() => {
    ${playerApiWireHelpersScript()}
    if (!isGameUrl(location.href)) return { installed: false };
    const key = '__cristePlayerApiCapture';
    const captureId = ${JSON.stringify(captureId)};
    if (window[key]?.captureId === captureId && window[key].observerVersion === 8 && window[key].active())
      return { installed: true, observerVersion: 8, hooks: window[key].hooks };
    window[key]?.stop();
    let active = true, reading = 0, recorded = 0;
    let responses = [], endpoints = [], sockets = [];
    const readers = new Set(), socketListeners = new Set();
    const idleResolvers = new Set();
    const notifyIdle = () => {
      if (reading) return;
      for (const resolve of idleResolvers) resolve();
      idleResolvers.clear();
    };
    const emptyCounts = () => ({ requestsSeen: 0, gameRequests: 0, webSocketFramesSeen: 0,
      skippedLarge: 0, binaryResponses: 0, bodyUnavailable: 0, bodyReadsSkippedBusy: 0, captureErrors: 0, wireResponses: 0, playerResponses: 0 });
    let counts = emptyCounts();
    const nativeFetch = window.fetch;
    const xhrPrototype = window.XMLHttpRequest?.prototype;
    const nativeSend = xhrPrototype?.send;
    const NativeSocket = window.WebSocket;
    const staticUrl = (url) => {
      try { return /\\.(?:bundle|unityweb|wasm|data|bytes|js|css|br|gz|png|jpg|webp)$/i.test(new URL(url, location.href).pathname); }
      catch { return true; }
    };
    const responseInfo = (url, type, status, mimeType = '') => {
      const mime = mimeType.split(';')[0].trim();
      return { endpoint: safeEndpoint(url), type, status,
        decoder: type === 'WebSocket' ? 'websocket-json' : !isGameUrl(url) ? 'metadata-only' : isGameApiEndpoint(url) ? 'game-wire' : 'json',
        mimeType: /^[\\w.+-]+\\/[\\w.+-]+$/.test(mime) ? mime : 'unknown' };
    };
    const record = (info, summary) => {
      if (!active || recorded >= 100 || !info.endpoint) return;
      recorded++;
      if (info.decoder === 'game-wire') counts.wireResponses++;
      if (summary.protobufPlayer) counts.playerResponses++;
      responses.push({ ...info, ...summary });
    };
    const observe = (info) => {
      if (active && endpoints.length < 60 && info.endpoint) endpoints.push({ ...info, gameScoped: true });
    };
    const inspectFetch = async (response) => {
      if (!active || staticUrl(response.url) || !safeEndpoint(response.url)) return;
      const info = responseInfo(response.url, 'Fetch', response.status, response.headers.get('content-type') || 'unknown');
      observe(info);
      if (!isGameUrl(response.url)) return;
      if (!response.ok || recorded >= 100) return;
      if (Number(response.headers.get('content-length') || 0) > MAX_BODY) { counts.skippedLarge++; return; }
      const gameApi = isGameApiEndpoint(response.url);
      if (!gameApi && !/json|^text\\//i.test(info.mimeType)) {
        counts.binaryResponses++;
        record(info, { format: 'not-read', fields: [], candidates: [] });
        return;
      }
      if (reading >= 2) { counts.bodyReadsSkippedBusy++; return; }
      reading++;
      let reader;
      try {
        reader = response.clone().body?.getReader();
        if (!reader) return;
        readers.add(reader);
        const chunks = []; let size = 0;
        while (active) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) { counts.skippedLarge++; return; }
          chunks.push(value);
        }
        if (!active) return;
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        record(info, gameApi ? await summarizePlayerWire(bytes) : summarizePlayerJson(new TextDecoder().decode(bytes)));
      } catch { if (active) counts.bodyUnavailable++; }
      finally {
        reading--;
        notifyIdle();
        if (reader) { readers.delete(reader); reader.cancel().catch(() => {}); }
      }
    };
    const wrappedFetch = typeof nativeFetch === 'function' ? function(...args) {
      const promise = Reflect.apply(nativeFetch, this, args);
      if (active) {
        counts.requestsSeen++;
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (!staticUrl(url)) counts.gameRequests++;
        promise.then(inspectFetch, () => {}).catch(() => { if (active) counts.captureErrors++; });
      }
      return promise;
    } : undefined;
    const inspectXhr = (xhr) => {
      if (!active || staticUrl(xhr.responseURL) || !safeEndpoint(xhr.responseURL)) return;
      try {
        const info = responseInfo(xhr.responseURL, 'XHR', xhr.status, xhr.getResponseHeader('content-type') || 'unknown');
        observe(info);
        if (!isGameUrl(xhr.responseURL)) return;
        if (xhr.status < 200 || xhr.status >= 300 || recorded >= 100) return;
        if (Number(xhr.getResponseHeader('content-length') || 0) > MAX_BODY) { counts.skippedLarge++; return; }
        if (xhr.responseType === 'json') { record(info, summarizePlayerData(xhr.response)); return; }
        const gameApi = isGameApiEndpoint(xhr.responseURL);
        if (gameApi && (xhr.responseType === '' || xhr.responseType === 'text' || xhr.responseType === 'arraybuffer')) {
          let bytes;
          if (xhr.responseType === 'arraybuffer') bytes = new Uint8Array(xhr.response || new ArrayBuffer(0));
          else {
            if (xhr.responseText.length > MAX_BODY) { counts.skippedLarge++; return; }
            bytes = new TextEncoder().encode(xhr.responseText);
          }
          if (bytes.byteLength > MAX_BODY) { counts.skippedLarge++; return; }
          if (reading >= 2) { counts.bodyReadsSkippedBusy++; return; }
          reading++;
          summarizePlayerWire(bytes).then((summary) => record(info, summary))
            .catch(() => { if (active) counts.captureErrors++; }).finally(() => { reading--; notifyIdle(); });
          return;
        }
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          record(info, summarizePlayerJson(xhr.responseText));
        } else if (xhr.responseType === 'arraybuffer' && /json|^text\\//i.test(info.mimeType)) {
          if (xhr.response?.byteLength > MAX_BODY) { counts.skippedLarge++; return; }
          record(info, summarizePlayerJson(new TextDecoder().decode(xhr.response)));
        } else {
          counts.binaryResponses++;
          record(info, { format: 'not-read', fields: [], candidates: [] });
        }
      } catch { if (active) counts.captureErrors++; }
    };
    const wrappedSend = typeof nativeSend === 'function' ? function(...args) {
      const listener = () => inspectXhr(this);
      if (active) {
        counts.requestsSeen++; counts.gameRequests++;
        try { this.addEventListener('loadend', listener, { once: true }); } catch {}
      }
      try { return Reflect.apply(nativeSend, this, args); }
      catch (error) { this.removeEventListener('loadend', listener); throw error; }
    } : undefined;
    const WrappedSocket = typeof NativeSocket === 'function' ? new Proxy(NativeSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        if (!active || sockets.length >= 20) return socket;
        const endpoint = safeEndpoint(socket.url);
        const entry = { endpoint, gameScoped: true, receivedFrames: 0, textFrames: 0, binaryFrames: 0 };
        sockets.push(entry);
        const listener = (event) => {
          if (!active) return;
          counts.webSocketFramesSeen++; entry.receivedFrames++;
          if (typeof event.data === 'string') {
            entry.textFrames++;
            if (recorded < 100)
              record(responseInfo(socket.url, 'WebSocket', 101, 'text/plain'), summarizePlayerJson(event.data));
          } else { entry.binaryFrames++; }
        };
        socket.addEventListener('message', listener);
        socketListeners.add({ socket, listener });
        return socket;
      },
    }) : undefined;
    if (wrappedFetch) window.fetch = wrappedFetch;
    if (wrappedSend) xhrPrototype.send = wrappedSend;
    if (WrappedSocket) window.WebSocket = WrappedSocket;
    let timer;
    const stop = () => {
      if (!active) return;
      active = false; clearTimeout(timer);
      if (window.fetch === wrappedFetch) window.fetch = nativeFetch;
      if (xhrPrototype?.send === wrappedSend) xhrPrototype.send = nativeSend;
      if (window.WebSocket === WrappedSocket) window.WebSocket = NativeSocket;
      for (const reader of readers) reader.cancel().catch(() => {});
      readers.clear();
      for (const { socket, listener } of socketListeners) socket.removeEventListener('message', listener);
      socketListeners.clear();
    };
    const takeReport = () => {
      const result = { counts, responses, observedApiEndpoints: endpoints, webSocketTransports: sockets.map((socket) => ({ ...socket })) };
      counts = emptyCounts(); responses = []; endpoints = [];
      for (const socket of sockets) { socket.receivedFrames = 0; socket.textFrames = 0; socket.binaryFrames = 0; }
      return result;
    };
    const hooks = { fetch: window.fetch === wrappedFetch, xhr: !!wrappedSend && xhrPrototype.send === wrappedSend,
      webSocket: !!WrappedSocket && window.WebSocket === WrappedSocket };
    Object.defineProperty(window, key, { configurable: true, value: {
      captureId, observerVersion: 8, hooks, active: () => active, stop, takeReport,
      whenIdle: () => new Promise((resolve) => { if (reading) idleResolvers.add(resolve); else resolve(); }),
    } });
    timer = setTimeout(stop, 180000);
    return { installed: true, observerVersion: 8, hooks };
  })()`;
}

module.exports = { playerApiFrameScript };
