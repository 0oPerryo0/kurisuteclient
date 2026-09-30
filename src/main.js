const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, webFrameMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fpsScript } = require('./fps-script');
const { gameOnlyScript } = require('./game-only-script');
const { osapiLayoutScript } = require('./osapi-layout-script');

const HOME = 'https://games.dmm.co.jp/detail/charsapple_x_879635';
const TOOLBAR_HEIGHT = 48;
const GAME_WIDTH = 1136;
const GAME_HEIGHT = 640;
const FPS_OPTIONS = [0, 30, 60, 120, 144];
const ZOOM_OPTIONS = [0.75, 0.9, 1, 1.25, 1.5];
const defaults = { pin: false, gameOnly: true, mute: false, zoom: 1, fps: 0, bounds: { width: 1100, height: 820 } };
let settings;
let window;
let game;
let status = 'Loading…';
let ambientTimer;
let ambientBusy = false;

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
function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('client:state', state());
}
function resizeGame() {
  const [width, height] = window.getContentSize();
  game.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
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
function applyFps() {
  if (!game || game.webContents.isDestroyed()) return;
  const script = fpsScript(settings.fps);
  const visit = (frame) => {
    if (!frame) return;
    frame.executeJavaScript(script).catch(() => {});
    for (const child of frame.frames) visit(child);
  };
  visit(game.webContents.mainFrame);
}
function applyFpsToFrame(processId, routingId) {
  if (!settings.fps) return;
  const frame = webFrameMain.fromId(processId, routingId);
  if (frame) frame.executeJavaScript(fpsScript(settings.fps)).catch(() => {});
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
    ambientTimer = setInterval(refreshAmbient, 4000);
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
function secureWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => ({
    action: url.startsWith('https://') ? 'allow' : 'deny',
    overrideBrowserWindowOptions: {
      webPreferences: { partition: 'persist:criste', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
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
    backgroundColor: '#181b25',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  game = new WebContentsView({
    webPreferences: { partition: 'persist:criste', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.contentView.addChildView(game);
  resizeGame();
  window.on('resize', resizeGame);
  window.on('enter-full-screen', publish);
  window.on('leave-full-screen', publish);
  window.on('close', () => {
    clearInterval(ambientTimer);
    if (!window.isMaximized() && !window.isFullScreen()) settings.bounds = window.getBounds();
    save();
  });
  secureWebContents(game.webContents);
  game.webContents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (isMainFrame) { applyGameOnly(); updateAmbientTimer(); }
    applyOsapiLayout(webFrameMain.fromId(processId, routingId));
    applyFpsToFrame(processId, routingId);
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
  session.fromPartition('persist:criste');
  ipcMain.handle('client:command', async (event, command, value) => {
    if (event.sender !== window.webContents) throw new Error('Untrusted sender');
    switch (command) {
      case 'state': break;
      case 'home': await game.webContents.loadURL(HOME); break;
      case 'reload': game.webContents.reload(); break;
      case 'pin': settings.pin = !settings.pin; window.setAlwaysOnTop(settings.pin); break;
      case 'gameOnly': settings.gameOnly = !settings.gameOnly; applyGameOnly(); updateOsapiLayout(); updateAmbientTimer(); break;
      case 'fullscreen': window.setFullScreen(!window.isFullScreen()); break;
      case 'mute': settings.mute = !settings.mute; game.webContents.setAudioMuted(settings.mute); break;
      case 'zoom':
        if (!ZOOM_OPTIONS.includes(value)) throw new Error('Invalid zoom');
        settings.zoom = value; game.webContents.setZoomFactor(value); updateMinimumSize(); break;
      case 'fps':
        if (!FPS_OPTIONS.includes(value)) throw new Error('Invalid FPS');
        settings.fps = value; applyFps(); break;
      case 'screenshot': {
        const file = await dialog.showSaveDialog(window, { defaultPath: 'criste-screenshot.png', filters: [{ name: 'PNG image', extensions: ['png'] }] });
        if (!file.canceled && file.filePath) fs.writeFileSync(file.filePath, (await game.webContents.capturePage()).toPNG());
        break;
      }
      case 'layoutReport': await saveLayoutReport(); break;
      default: throw new Error('Unknown command');
    }
    save();
    publish();
    return state();
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
