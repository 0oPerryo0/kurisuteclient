const { app, BrowserWindow, Menu, WebContentsView, ipcMain, dialog, session, webFrameMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fpsScript } = require('./fps-script');
const { gameClockScript } = require('./game-clock');
const { gameOnlyScript } = require('./game-only-script');
const { osapiLayoutScript } = require('./osapi-layout-script');
const { guessScript, OBJECTS, METHODS } = require('./unity-guesses');
const { unityBuildResourceListScript } = require('./unity-build-analyzer');
const { unityRuntimeInspectorScript } = require('./unity-runtime');
const { unityPointerProbeScript } = require('./unity-pointer-probe');
const { inspectAsset, decodedBytes } = require('./asset-analysis');
const { extractMetadata, parseMetadata } = require('./il2cpp-metadata');
const { isDmmGamePage, withRegionCookie, isDmmRegionCookie, syncRegionCookie, removeRegionCookie } = require('./region-cookie');

// Unity's WASM heap is most of the RAM and cannot be shrunk. These only remove
// extra Chromium processes and unused features.
app.commandLine.appendSwitch('renderer-process-limit', '2');
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,IsolateOrigins,site-per-process');
const HOME = 'https://games.dmm.co.jp/detail/charsapple_x_879635';
const APP_ICON = path.join(__dirname, 'icon.ico');
const TOOLBAR_HEIGHT = 0;
const GAME_WIDTH = 1136;
const GAME_HEIGHT = 640;
const FPS_OPTIONS = [0, 30, 60, 120, 144];
const SPEED_OPTIONS = [1, 2, 3, 5, 10];
const ZOOM_OPTIONS = [0.75, 0.9, 1, 1.25, 1.5];
const defaults = {
  pin: false, gameOnly: true, mute: false, zoom: 1, fps: 0, speed: 1, regionCookie: true,
  bridgeEnabled: false, bridgeObject: 'GameManager', bridgeMethod: 'SetTimeScale',
  bounds: { width: 1100, height: 820 },
};
const OBJECT_NAME = /^[\w /-]{1,80}$/;
const METHOD_NAME = /^[A-Za-z_]\w{0,79}$/;
let settings;
let window;
let game;
let bridgeWindow;
let status = 'Loading…';
let ambientTimer;
let ambientBusy = false;
let regionCookieTask = Promise.resolve();

function queueRegionCookieUpdate(action) {
  regionCookieTask = regionCookieTask.catch(() => {}).then(action);
  regionCookieTask.catch((error) => { status = `Cookie update failed: ${error.message}`; publish(); });
  return regionCookieTask;
}

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function save() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      ...defaults,
      pin: saved.pin === true,
      gameOnly: saved.gameOnly !== false,
      mute: saved.mute === true,
      zoom: ZOOM_OPTIONS.includes(saved.zoom) ? saved.zoom : 1,
      fps: FPS_OPTIONS.includes(saved.fps) ? saved.fps : 0,
      speed: SPEED_OPTIONS.includes(saved.speed) ? saved.speed : 1,
      regionCookie: saved.regionCookie !== false,
      bridgeEnabled: saved.bridgeEnabled === true,
      bridgeObject: typeof saved.bridgeObject === 'string' && OBJECT_NAME.test(saved.bridgeObject)
        ? saved.bridgeObject : defaults.bridgeObject,
      bridgeMethod: typeof saved.bridgeMethod === 'string' && METHOD_NAME.test(saved.bridgeMethod)
        ? saved.bridgeMethod : defaults.bridgeMethod,
      bounds: {
        width: Math.max(640, Number(saved.bounds?.width) || 1100),
        height: Math.max(480, Number(saved.bounds?.height) || 820),
      },
    };
  } catch { return { ...defaults }; }
}
function state() {
  return { ...settings, fullscreen: window.isFullScreen(), status };
}
async function runCommand(command, value) {
  switch (command) {
    case 'state': break;
    case 'home': await game.webContents.loadURL(HOME); break;
    case 'reload': game.webContents.reload(); break;
    case 'pin': settings.pin = !settings.pin; window.setAlwaysOnTop(settings.pin); break;
    case 'gameOnly': settings.gameOnly = !settings.gameOnly; applyGameOnly(); updateOsapiLayout(); updateAmbientTimer(); break;
    case 'fullscreen': window.setFullScreen(!window.isFullScreen()); break;
    case 'mute': settings.mute = !settings.mute; game.webContents.setAudioMuted(settings.mute); break;
    case 'regionCookie': {
      settings.regionCookie = !settings.regionCookie;
      const enabled = settings.regionCookie;
      await queueRegionCookieUpdate(() => enabled
        ? syncRegionCookie(game.webContents.session.cookies)
        : removeRegionCookie(game.webContents.session.cookies));
      break;
    }
    case 'deleteCookies': {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Cancel', 'Delete cookies'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Delete app cookies?',
        message: 'Delete cookies saved by this app?',
        detail: 'This signs you out of DMM. It does not delete your settings or cookies in your regular browser.',
      });
      if (response !== 1) break;
      await game.webContents.session.clearStorageData({ storages: ['cookies'] });
      status = 'App cookies deleted. Use Home or Reload to sign in again.';
      break;
    }
    case 'zoom':
      if (!ZOOM_OPTIONS.includes(value)) throw new Error('Invalid zoom');
      settings.zoom = value; game.webContents.setZoomFactor(value); updateMinimumSize(); break;
    case 'fps':
      if (!FPS_OPTIONS.includes(value)) throw new Error('Invalid FPS');
      settings.fps = value; applyFps(); break;
    case 'speed':
      if (!SPEED_OPTIONS.includes(value)) throw new Error('Invalid speed');
      settings.speed = value;
      applySpeed();
      status = value === 1 ? 'Game clock at 1×' : `Game clock at ${value}×. Reload the game if it already started.`;
      break;
    case 'bridge': openBridgeWindow(); break;
    case 'bridgeSettings': {
      if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' ||
          typeof value.object !== 'string' || !OBJECT_NAME.test(value.object) ||
          typeof value.method !== 'string' || !METHOD_NAME.test(value.method)) throw new Error('Invalid Unity target');
      if (settings.bridgeEnabled && (!value.enabled || value.object !== settings.bridgeObject ||
          value.method !== settings.bridgeMethod)) await sendUnitySpeed(1).catch(() => {});
      settings.bridgeEnabled = value.enabled;
      settings.bridgeObject = value.object;
      settings.bridgeMethod = value.method;
      if (settings.bridgeEnabled) status = await sendUnitySpeed(settings.speed);
      else status = 'Unity bridge disabled';
      break;
    }
    case 'tryUnityGuesses': return { ...state(), status: await tryUnityGuesses() };
    case 'analyzeUnityBuild': return { ...state(), status: await analyzeUnityBuild() };
    case 'inspectUnityRuntime': return { ...state(), status: await inspectUnityRuntime() };
    case 'probeUnityPointers': return { ...state(), status: await probeUnityPointers() };
    case 'screenshot': {
      const file = await dialog.showSaveDialog(window, { defaultPath: 'criste-screenshot.png', filters: [{ name: 'PNG image', extensions: ['png'] }] });
      if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath, (await game.webContents.capturePage()).toPNG());
      break;
    }
    case 'layoutReport': await saveLayoutReport(); break;
    case 'timingReport': await saveTimingReport(); break;
    default: throw new Error('Unknown command');
  }
  save();
  publish();
  return state();
}
function showClientMenu(params = {}) {
  const choose = (command, current, options, label) => options.map((value) => ({
    label: label(value), type: 'radio', checked: current === value,
    click: () => runCommand(command, value).catch((error) => { status = error.message; publish(); }),
  }));
  const edit = params.isEditable
    ? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }]
    : params.selectionText ? [{ role: 'copy' }, { type: 'separator' }] : [];
  Menu.buildFromTemplate([
    ...edit,
    { label: 'Home', click: () => runCommand('home').catch((error) => { status = error.message; publish(); }) },
    { label: 'Reload', click: () => runCommand('reload').catch((error) => { status = error.message; publish(); }) },
    { label: 'Pin', type: 'checkbox', checked: settings.pin, click: () => runCommand('pin') },
    { label: 'Game only', type: 'checkbox', checked: settings.gameOnly, click: () => runCommand('gameOnly') },
    { label: 'Fullscreen', type: 'checkbox', checked: !!window?.isFullScreen(), click: () => runCommand('fullscreen') },
    { label: 'Mute', type: 'checkbox', checked: settings.mute, click: () => runCommand('mute') },
    { label: 'DMM region cookie override', type: 'checkbox', checked: settings.regionCookie,
      click: () => runCommand('regionCookie') },
    { label: 'Delete cookies…', click: () => runCommand('deleteCookies').catch((error) => { status = error.message; publish(); }) },
    { label: 'Zoom', submenu: choose('zoom', settings.zoom, ZOOM_OPTIONS, (value) => `${Math.round(value * 100)}%`) },
    { label: 'FPS', submenu: choose('fps', settings.fps, FPS_OPTIONS, (value) => value ? String(value) : 'Native') },
    { label: 'Speed', submenu: choose('speed', settings.speed, SPEED_OPTIONS, (value) => `${value}×`) },
    { label: 'Screenshot', click: () => runCommand('screenshot').catch((error) => { status = error.message; publish(); }) },
    { type: 'separator' },
    { label: String(status || 'Loading…').slice(0, 140), enabled: false },
  ]).popup({ window });
}
function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('client:state', state());
}
function resizeGame() {
  const [width, height] = window.getContentSize();
  game.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}
function wakeGameView() {
  if (!window || window.isDestroyed() || window.isMinimized() || !game || game.webContents.isDestroyed()) return;
  resizeGame();
  const bounds = game.getBounds();
  if (bounds.width < 2 || bounds.height < 2) return;
  // Child views can keep a discarded frame after the taskbar hides and restores the window.
  game.setBounds({ ...bounds, height: bounds.height - 1 });
  game.setBounds(bounds);
}
function wakeGameViewSoon() {
  wakeGameView();
  setTimeout(wakeGameView, 50);
  setTimeout(wakeGameView, 200);
}
function updateMinimumSize() {
  // BrowserWindow minimums include Windows' non-client title bar and borders.
  const [outerWidth, outerHeight] = window.getSize();
  const [contentWidth, contentHeight] = window.getContentSize();
  window.setMinimumSize(
    Math.ceil(GAME_WIDTH * settings.zoom) + outerWidth - contentWidth,
    Math.ceil(GAME_HEIGHT * settings.zoom) + TOOLBAR_HEIGHT + outerHeight - contentHeight,
  );
}
function injectClock(frame) {
  if (!frame?.url.startsWith('https://games.mofushippo.com/')) return;
  frame.executeJavaScript(gameClockScript(settings.speed))
    .then(() => frame.executeJavaScript(`window.__cristeClock?.setSpeed(${settings.speed})`))
    .catch(() => {});
}
function applySpeed() {
  if (!game || game.webContents.isDestroyed()) return;
  const visit = (frame) => {
    if (!frame) return;
    injectClock(frame);
    for (const child of frame.frames) visit(child);
  };
  visit(game.webContents.mainFrame);
}
function applyFps() {
  if (!game || game.webContents.isDestroyed()) return;
  const script = fpsScript(settings.fps);
  const visit = (frame) => {
    if (!frame) return;
    if (frame.url.startsWith('https://games.mofushippo.com/'))
      frame.executeJavaScript(script).catch(() => {});
    for (const child of frame.frames) visit(child);
  };
  visit(game.webContents.mainFrame);
}
function applyFpsToFrame(processId, routingId) {
  if (!settings.fps) return;
  const frame = webFrameMain.fromId(processId, routingId);
  if (frame?.url.startsWith('https://games.mofushippo.com/'))
    frame.executeJavaScript(fpsScript(settings.fps)).catch(() => {});
}
function gameFrame() {
  let found;
  function visit(frame) {
    if (!frame) return;
    if (frame.url.startsWith('https://games.mofushippo.com/')) found = frame;
    for (const child of frame.frames) visit(child);
  }
  if (game && !game.webContents.isDestroyed()) visit(game.webContents.mainFrame);
  return found;
}
async function sendUnitySpeed(speed, object = settings.bridgeObject, method = settings.bridgeMethod) {
  const frame = gameFrame();
  if (!frame) return 'Game frame not ready';
  const result = await frame.executeJavaScript(`(() => {
    if (typeof window.unityInstance?.SendMessage !== 'function') return 'Unity is still loading';
    try {
      window.unityInstance.SendMessage(${JSON.stringify(object)}, ${JSON.stringify(method)}, ${speed});
      return 'Sent to Unity (method existence is not verifiable from JavaScript)';
    } catch (error) { return 'Unity call failed: ' + String(error?.message || error).slice(0, 100); }
  })()`);
  return result;
}
async function tryUnityGuesses() {
  const frame = gameFrame();
  if (!frame) throw new Error('Game frame has not loaded yet');
  const restoreSpeed = settings.bridgeEnabled && settings.speed !== 1;
  if (restoreSpeed) await sendUnitySpeed(1).catch(() => {});
  const results = [];
  try {
    for (const object of OBJECTS) for (const method of METHODS) {
      let rejected = false;
      const onConsole = (_event, details) => {
        const message = typeof details === 'string' ? details : details?.message || '';
        if (/sendmessage|no receiver|object .*not found|method .*not found/i.test(message))
          rejected = true;
      };
      game.webContents.on('console-message', onConsole);
      try {
        if (!await frame.executeJavaScript(guessScript(object, method)))
          throw new Error('Unity is not ready');
        await new Promise((resolve) => setTimeout(resolve, 120));
      } catch (error) {
        if (String(error.message).includes('Unity is not ready')) throw error;
        rejected = true;
      } finally { game.webContents.off('console-message', onConsole); }
      results.push({ object, method, result: rejected ? 'rejected' : 'no detected error' });
    }
  } finally {
    if (restoreSpeed && settings.bridgeEnabled) await sendUnitySpeed(settings.speed).catch(() => {});
  }
  const file = await dialog.showSaveDialog(bridgeWindow, {
    defaultPath: 'criste-unity-guesses.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath, JSON.stringify({
    note: 'A call without a detected error is NOT proof that the method exists or changes gameplay.',
    results,
  }, null, 2));
  const possible = results.filter((item) => item.result !== 'rejected');
  return `${possible.length} of ${results.length} guesses had no detected error. This is not proof of a match.`;
}
async function analyzeUnityBuild() {
  const frame = gameFrame();
  if (!frame) throw new Error('Game frame has not loaded yet');
  const urls = await frame.executeJavaScript(unityBuildResourceListScript());
  const report = { engine: 'Unity WebGL', assetCount: urls.length, assets: [] };
  for (const url of urls) {
    const name = new URL(url).pathname.split('/').pop()?.slice(0, 100) || 'asset';
    const item = { name };
    report.assets.push(item);
    try {
      const response = await session.fromPartition('persist:criste').fetch(url, { credentials: 'include' });
      if (!response.ok || !response.body) { item.error = `HTTP ${response.status}`; continue; }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      const limit = 26 * 1024 * 1024;
      while (size < limit) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        size += value.length;
      }
      if (size >= limit) {
        await reader.cancel();
        item.error = 'Compressed asset exceeds 26 MiB scan limit';
        continue;
      }
      const asset = Buffer.concat(chunks, size);
      Object.assign(item, await inspectAsset(asset, name));
      if (/\.data(?:\.unityweb|\.gz|\.br)?$/i.test(name)) {
        try {
          const decoded = await decodedBytes(asset, name);
          if (decoded.truncated) throw new Error('Data archive exceeds decode limit');
          report.metadata = parseMetadata(extractMetadata(decoded.bytes));
        } catch (error) { report.metadataError = String(error.message).slice(0, 160); }
      }
    } catch { item.error = 'Asset fetch or decode failed'; }
  }
  const file = await dialog.showSaveDialog(bridgeWindow, {
    defaultPath: 'criste-unity-build-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath, JSON.stringify({
    note: 'Decompressed asset matches and IL2CPP speed-related declarations only. No URLs, cookies or asset files.',
    ...report,
  }, null, 2));
  const bridge = report.metadata?.bridge;
  return bridge
    ? `${bridge.type}.${bridge.method} is ${bridge.static ? 'static' : 'an instance method'}. ${bridge.note}`
    : `Inspected ${report.assets.length} of ${report.assetCount} Unity assets. Review the saved report.`;
}
async function inspectUnityRuntime() {
  const frame = gameFrame();
  if (!frame) throw new Error('Game frame has not loaded yet');
  const report = await frame.executeJavaScript(unityRuntimeInspectorScript());
  const file = await dialog.showSaveDialog(bridgeWindow, {
    defaultPath: 'criste-unity-runtime.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath, JSON.stringify({
    note: 'Loaded Unity object and export names only. No values, URLs, cookies or calls.',
    ...report,
  }, null, 2));
  const leads = report.speedExports || [];
  return leads.length
    ? `Runtime exposes ${leads.length} named speed-related exports. Review the saved report.`
    : `Scanned ${report.exportCount || 0} exports. No named time-scale export is visible to JavaScript.`;
}
async function probeUnityPointers() {
  const frame = gameFrame();
  if (!frame) throw new Error('Game frame has not loaded yet');
  const report = await frame.executeJavaScript(unityPointerProbeScript());
  const file = await dialog.showSaveDialog(bridgeWindow, {
    defaultPath: 'criste-unity-pointers.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath, JSON.stringify({
    note: 'Heap string addresses and nearby pointer words only. No calls, URLs, cookies or asset bytes.',
    ...report,
  }, null, 2));
  const refs = (report.strings || []).reduce((count, item) => count + (item.references?.length || 0), 0);
  if (report.error) return report.error;
  if (report.truncated) return 'Heap search stopped after 20 seconds. Review the partial report.';
  return refs
    ? `Found ${refs} pointers to speed-related strings. Review the saved report.`
    : 'No pointers to SetTimeScale or time.scale were found in the Unity heap.';
}
function openBridgeWindow() {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) { bridgeWindow.focus(); return; }
  bridgeWindow = new BrowserWindow({
    parent: window, modal: true, width: 520, height: 560, resizable: false,
    title: 'Unity speed bridge', backgroundColor: '#181b25', icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  bridgeWindow.loadFile(path.join(__dirname, 'bridge.html'));
  bridgeWindow.on('closed', () => { bridgeWindow = null; });
}
function applyGameOnly() {
  if (!game || game.webContents.isDestroyed()) return;
  let host;
  try { host = new URL(game.webContents.getURL()).hostname; } catch { return; }
  if (host !== 'play.games.dmm.co.jp') return;
  game.webContents.executeJavaScript(gameOnlyScript(settings.gameOnly)).catch(() => {});
}
async function refreshAmbient() {
  if (ambientBusy || !settings.gameOnly || !window || window.isDestroyed() ||
      window.isMinimized() || !game || game.webContents.isDestroyed()) return;
  if (!game.webContents.getURL().startsWith('https://play.games.dmm.co.jp/')) return;
  ambientBusy = true;
  try {
    const rect = await game.webContents.executeJavaScript('window.__cristeGameOnly?.getStageRect()');
    if (!rect || rect.width < 250 || rect.height < 200) return;
    if (rect.width >= rect.viewportWidth - 2 && rect.height >= rect.viewportHeight - 2) return;
    const image = await game.webContents.capturePage({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    });
    if (image.isEmpty()) return;
    const sample = image.resize({ width: 96, height: 54 });
    const { width, height } = sample.getSize();
    const bitmap = sample.toBitmap();
    const average = (points) => {
      let red = 0, green = 0, blue = 0;
      for (const [x, y] of points) {
        const index = (y * width + x) * 4;
        blue += bitmap[index]; green += bitmap[index + 1]; red += bitmap[index + 2];
      }
      return '#' + [red, green, blue].map((channel) =>
        Math.round(channel / points.length).toString(16).padStart(2, '0')).join('');
    };
    const side = (name) => {
      const points = [];
      if (name === 'top' || name === 'bottom') {
        for (let x = 4; x < width - 4; x++)
          for (let i = 0; i < 3; i++) points.push([x, name === 'top' ? i : height - 1 - i]);
      } else {
        for (let y = 4; y < height - 4; y++)
          for (let i = 0; i < 3; i++) points.push([name === 'left' ? i : width - 1 - i, y]);
      }
      return average(points);
    };
    const colors = ['top', 'right', 'bottom', 'left'].map(side);
    if (game.webContents.getURL().startsWith('https://play.games.dmm.co.jp/')) {
      await game.webContents.executeJavaScript(
        `window.__cristeGameOnly?.setColors(${JSON.stringify(colors)})`,
      );
    }
  } catch { /* Page may be navigating or not ready yet. */ }
  finally { ambientBusy = false; }
}
function updateAmbientTimer() {
  clearInterval(ambientTimer);
  ambientTimer = undefined;
  if (settings.gameOnly && game && !game.webContents.isDestroyed() &&
      game.webContents.getURL().startsWith('https://play.games.dmm.co.jp/')) {
    ambientTimer = setInterval(refreshAmbient, 15000);
    refreshAmbient();
  }
}
function applyOsapiLayout(frame) {
  if (!frame || !frame.url.startsWith('https://osapi.games.dmm.com/')) return;
  frame.executeJavaScript(osapiLayoutScript(settings.gameOnly)).catch(() => {});
}
function updateOsapiLayout() {
  function visit(frame) {
    if (!frame) return;
    applyOsapiLayout(frame);
    for (const child of frame.frames) visit(child);
  }
  visit(game.webContents.mainFrame);
}
const layoutScript = `(() => {
  const sample = (element) => {
    const rect = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      background: css.backgroundColor, position: css.position, overflow: css.overflow,
      display: css.display, visibility: css.visibility,
    };
  };
  const candidates = [...document.querySelectorAll('canvas, iframe, video')]
    .filter((element) => element.getBoundingClientRect().width >= 250)
    .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height -
      a.getBoundingClientRect().width * a.getBoundingClientRect().height)
    .slice(0, 5);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    document: [sample(document.documentElement), sample(document.body)],
    candidates: candidates.map((element) => {
      const ancestors = [];
      for (let node = element; node && ancestors.length < 7; node = node.parentElement) ancestors.push(sample(node));
      return ancestors;
    }),
  };
})()`;
async function saveLayoutReport() {
  const report = { note: 'Geometry and colors only; no page text, cookies or URL paths.', frames: [] };
  async function visit(frame) {
    if (!frame) return;
    let origin = 'unavailable';
    try { origin = new URL(frame.url).origin; } catch {}
    try {
      report.frames.push({ origin, layout: await frame.executeJavaScript(layoutScript) });
    } catch { report.frames.push({ origin, error: 'Frame unavailable' }); }
    for (const child of frame.frames) await visit(child);
  }
  await visit(game.webContents.mainFrame);
  const file = await dialog.showSaveDialog(window, {
    defaultPath: 'criste-layout-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath, JSON.stringify(report, null, 2));
}
const timingProbe = `(() => {
  const timing = window.__cristeTimingPrototype;
  const engines = ['cc', 'PIXI', 'Phaser', 'Laya', 'egret', 'unityInstance',
    'UnityLoader', 'createUnityInstance', 'Module', 'Godot'];
  const canvas = [...document.querySelectorAll('canvas')].map((element) => ({
    width: element.width, height: element.height,
    visibleWidth: Math.round(element.getBoundingClientRect().width),
    visibleHeight: Math.round(element.getBoundingClientRect().height),
  }));
  return {
    visible: document.visibilityState, now: performance.now(),
    timing: timing ? {
      cap: timing.cap, callbacks: timing.callbacks, lastReal: timing.lastReal,
    } : null,
    engines: Object.fromEntries(engines.map((name) => [name, typeof window[name]])),
    canvas,
  };
})()`;
async function saveTimingReport() {
  let frame;
  function find(current) {
    if (!current) return;
    if (current.url.startsWith('https://games.mofushippo.com/')) frame = current;
    for (const child of current.frames) find(child);
  }
  find(game.webContents.mainFrame);
  if (!frame) throw new Error('Game frame has not loaded yet');
  const before = await frame.executeJavaScript(timingProbe);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const after = await frame.executeJavaScript(timingProbe);
  const file = await dialog.showSaveDialog(window, {
    defaultPath: 'criste-timing-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath,
    JSON.stringify({ note: 'No cookies, page text, requests or URLs are included.', before, after }, null, 2));
}
function secureWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => ({
    action: url.startsWith('https://') ? 'allow' : 'deny',
    overrideBrowserWindowOptions: {
      icon: APP_ICON,
      webPreferences: { partition: 'persist:criste', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: true },
      width: 900, height: 720,
    },
  }));
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://')) event.preventDefault();
  });
  contents.on('did-create-window', (popup) => secureWebContents(popup.webContents));
}

function createWindow() {
  window = new BrowserWindow({
    ...settings.bounds,
    minWidth: 760, minHeight: 520,
    title: 'クリステの遺宝 — Unofficial Desktop Prototype',
    icon: APP_ICON,
    backgroundColor: '#181b25',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  game = new WebContentsView({
    webPreferences: { partition: 'persist:criste', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  window.contentView.addChildView(game);
  resizeGame();
  window.on('resize', resizeGame);
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  window.on('restore', wakeGameViewSoon);
  window.on('show', wakeGameViewSoon);
  window.on('enter-full-screen', publish);
  window.on('leave-full-screen', publish);
  window.on('close', () => {
    clearInterval(ambientTimer);
    if (!window.isMaximized() && !window.isFullScreen()) settings.bounds = window.getBounds();
    save();
  });
  secureWebContents(game.webContents);
  game.webContents.on('context-menu', (event, params) => {
    event.preventDefault();
    showClientMenu(params);
  });
  game.webContents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (isMainFrame) { applyGameOnly(); updateAmbientTimer(); }
    applyOsapiLayout(webFrameMain.fromId(processId, routingId));
    applyFpsToFrame(processId, routingId);
    injectClock(webFrameMain.fromId(processId, routingId));
    const frame = webFrameMain.fromId(processId, routingId);
    if (settings.bridgeEnabled && frame?.url.startsWith('https://games.mofushippo.com/')) {
      setTimeout(() => { if (settings.bridgeEnabled) sendUnitySpeed(settings.speed).catch(() => {}); }, 5000);
    }
  });
  game.webContents.on('did-navigate', (_event, url) => {
    try { status = new URL(url).hostname; } catch { status = 'Game'; }
    publish();
    updateAmbientTimer();
  });
  game.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) { status = `Load failed: ${description}`; publish(); }
  });
  game.webContents.setAudioMuted(settings.mute);
  game.webContents.setZoomFactor(settings.zoom);
  window.setAlwaysOnTop(settings.pin);
  updateMinimumSize();
  window.loadFile(path.join(__dirname, 'index.html'));
  game.webContents.loadURL(HOME).catch((error) => { status = error.message; publish(); });
}

app.whenReady().then(() => {
  settings = readSettings();
  // Keep the DMM login session in this app, not in the user's regular browser.
  const gameSession = session.fromPartition('persist:criste');
  gameSession.setSpellCheckerEnabled(false);
  gameSession.cookies.on('changed', (_event, cookie, cause, removed) => {
    if (!settings.regionCookie || removed || !isDmmRegionCookie(cookie) ||
        cookie.value === 'ec_mrnhbtk') return;
    queueRegionCookieUpdate(() => settings.regionCookie
      ? syncRegionCookie(gameSession.cookies) : Promise.resolve());
  });
  queueRegionCookieUpdate(() => syncRegionCookie(gameSession.cookies));
  gameSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!settings.regionCookie || !['mainFrame', 'subFrame'].includes(details.resourceType) ||
        !isDmmGamePage(details.url)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const headers = { ...details.requestHeaders };
    const name = Object.keys(headers).find((key) => key.toLowerCase() === 'cookie') || 'Cookie';
    headers[name] = withRegionCookie(headers[name]);
    callback({ requestHeaders: headers });
  });
  ipcMain.handle('client:command', async (event, command, value) => {
    if (event.sender !== window.webContents && event.sender !== bridgeWindow?.webContents)
      throw new Error('Untrusted sender');
    if (['bridgeSettings', 'tryUnityGuesses', 'analyzeUnityBuild', 'inspectUnityRuntime', 'probeUnityPointers'].includes(command) &&
        event.sender !== bridgeWindow?.webContents) throw new Error('Open Unity bridge settings first');
    return runCommand(command, value);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
