const { app, BrowserWindow, Menu, WebContentsView, ipcMain, dialog, session, webFrameMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fpsScript } = require('./fps-script');
const { gameClockScript, SPEED_OPTIONS, selectSpeed } = require('./game-clock');
const { gameOnlyScript } = require('./game-only-script');
const { osapiLayoutScript } = require('./osapi-layout-script');
const { guessScript, OBJECTS, METHODS } = require('./unity-guesses');
const { unityBuildResourceListScript } = require('./unity-build-analyzer');
const { unityRuntimeInspectorScript } = require('./unity-runtime');
const { storyDiagnosticScript } = require('./story-diagnostic');
const { storyRuntimeProbeScript } = require('./story-runtime-probe');
const { isGameAsset, manifestAssets } = require('./game-asset-cache');
const { createGameAssetCache } = require('./game-asset-session');
const { gameAssetListScript } = require('./game-asset-list');
const { PlayerApiFrameDiagnostic } = require('./player-api-frame-diagnostic');
const { playerProtocolSchemaScript } = require('./player-protocol-schema');
const { PlayerStateMonitor } = require('./player-state-monitor');
const { DiscordPresence, DISCORD_APPLICATION_ID } = require('./discord-presence');
const { DEFAULT_WINDOW_TITLE, attachPlayerWindowTitle } = require('./player-window-title');
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
const ZOOM_OPTIONS = [0.75, 0.9, 1, 1.25, 1.5];
const defaults = {
  pin: false, gameOnly: true, mute: false, zoom: 1, fps: 0, speed: 1, regionCookie: true,
  bridgeEnabled: false, bridgeObject: 'GameManager', bridgeMethod: 'SetTimeScale',
  discordPresence: false,
  playerWindowTitle: true,
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
let assetCache;
let assetDownloadController;
let assetDownloadTask;
let playerApiDiagnostic;
let playerStateMonitor;
let discordPresence;
let playerTitle;
let presenceTask = Promise.resolve();
let regionCookieTask = Promise.resolve();

function recordProcessExit(processType, details) {
  if (details.reason === 'clean-exit') return;
  // Only native exit metadata, not URLs, page content, cookies or API payloads.
  const record = { time: new Date().toISOString(), processType,
    reason: details.reason, exitCode: details.exitCode, playerApiCaptureActive: !!playerApiDiagnostic?.active };
  console.error('Client process exit:', JSON.stringify(record));
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(path.join(app.getPath('userData'), 'client-process-exits.jsonl'), JSON.stringify(record) + '\n');
  } catch { /* Exit reporting must not cause another failure. */ }
}

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
      // Hidden 99× must be activated explicitly again after restarting the app.
      speed: SPEED_OPTIONS.includes(saved.speed) ? saved.speed : 1,
      regionCookie: saved.regionCookie !== false,
      bridgeEnabled: saved.bridgeEnabled === true,
      discordPresence: saved.discordPresence === true,
      playerWindowTitle: saved.playerWindowTitle !== false,
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
  return { ...settings, fullscreen: window.isFullScreen(), status,
    discordStatus: discordPresence?.status || 'Disabled' };
}
function updatePresence() {
  // Serialize privacy reconfiguration so an old reader cannot republish a name.
  discordPresence?.stop();
  playerTitle?.setPlayer(null);
  presenceTask = presenceTask.catch(() => {}).then(async () => {
    discordPresence?.stop();
    const previous = playerStateMonitor;
    playerStateMonitor = null;
    if (previous) await previous.stop();
    playerTitle?.setPlayer(null);
    if ((!settings.discordPresence && !settings.playerWindowTitle) || !window || window.isDestroyed()) return;
    if (settings.discordPresence) discordPresence = new DiscordPresence({ onStatus: () => publish() });
    const monitor = new PlayerStateMonitor(() => gameFrames(true), (player) => {
      if (playerStateMonitor !== monitor) return;
      playerTitle?.setPlayer(settings.playerWindowTitle ? player : null);
      if (settings.discordPresence) discordPresence.setPlayer(player, true);
    }, { shareName: settings.discordPresence || settings.playerWindowTitle, polling: settings.discordPresence });
    playerStateMonitor = monitor;
    if (settings.discordPresence) discordPresence.start();
    await monitor.start();
  });
  return presenceTask;
}
async function runCommand(command, value, menuEvent) {
  switch (command) {
    case 'state': break;
    case 'home': playerStateMonitor?.reset(); await game.webContents.loadURL(HOME); break;
    case 'reload': playerStateMonitor?.reset(); game.webContents.reload(); break;
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
      playerStateMonitor?.reset();
      discordPresence?.setPlayer(null, false, true);
      // Stop in-frame requests before clearing authentication, not after.
      const previous = playerStateMonitor;
      playerStateMonitor = null;
      if (previous) await previous.stop();
      await game.webContents.session.clearStorageData({ storages: ['cookies'] });
      await updatePresence();
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
      settings.speed = selectSpeed(value, menuEvent);
      applySpeed();
      status = settings.speed === 1 ? 'Game clock at 1×' : `Game clock at ${settings.speed}×. Reload the game if it already started.`;
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
    case 'storyDiagnostic': status = await inspectStoryUi(); break;
    case 'storyRuntimeProbe': status = await inspectStoryRuntime(); break;
    case 'startPlayerApiDiagnostic': status = await startPlayerApiDiagnostic(); break;
    case 'savePlayerApiDiagnostic': status = await savePlayerApiDiagnostic(); break;
    case 'discordPresence': {
      if (!settings.discordPresence) {
        const { response } = await dialog.showMessageBox(window, {
          type: 'question', title: 'Discord Rich Presence (stable)', message: 'Share your in-game nickname, level and stamina with Discord?',
          detail: `Uses Discord desktop and Application ID ${DISCORD_APPLICATION_ID}. Enabling includes nickname sharing, one-minute player refresh and debounced gameplay-triggered updates. Only an observed empty InitGameDataCs request matched to player data is reused; login, purchase and battle requests are never replayed. Extra refreshes are spaced at least 15 seconds apart and respect server backoff. Repeating initialization has not been independently verified to be side-effect-free. Credentials and player values stay in memory, never in settings or diagnostic reports. Discord shows last-read stamina and its age. Navigation, confirmed logout or disabling clears the activity and stops refreshes. Reload after enabling to observe the initial player request.`,
          buttons: ['Cancel', 'Enable'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (response !== 1) break;
      }
      settings.discordPresence = !settings.discordPresence;
      await updatePresence();
      status = settings.discordPresence ? 'Discord presence enabled with nickname sharing and automatic refresh. Reload the game to read player data.' : 'Discord presence disabled and cleared; automatic refresh stopped.';
      break;
    }
    case 'playerWindowTitle': {
      settings.playerWindowTitle = !settings.playerWindowTitle;
      await updatePresence();
      status = settings.playerWindowTitle ? 'Local player title enabled. Reload to read player data.' : 'Player title cleared.';
      break;
    }
    case 'discordPreview': {
      const player = playerStateMonitor?.snapshot();
      await dialog.showMessageBox(window, {
        type: 'info', title: 'Discord presence status', message: discordPresence?.status || 'Disabled',
        detail: `Application ID: ${DISCORD_APPLICATION_ID}\n${player
          ? `Level: ${player.level ?? 'unavailable'}\nStamina: ${player.stamina ?? 'unavailable or stale'}${player.staminaLastRead ? ` (last read ${player.staminaAgeMinutes}m ago)` : ''}\nNickname: ${settings.discordPresence ? player.nickname || 'waiting for reload' : 'not shared'}`
          : 'No player state yet. Enable presence and reload the game.'}\nRefresh: ${playerStateMonitor?.refreshState?.status || (settings.discordPresence ? 'Waiting for game reader' : 'Disabled')}\n${settings.discordPresence
          ? 'Refresh interval: 1 minute, plus debounced refreshes after recognized stage completions, sweeps and stamina-item actions. Stage-start stamina is read directly. Last-read values remain visible if a refresh fails; their age is shown. Rejected requests stop refreshing; temporary errors back off.'
          : 'Last-read values remain visible until reload, navigation, confirmed logout or disabling.'} Discord activity is resent every minute. No regeneration is estimated.`,
      });
      break;
    }
    case 'downloadAssets': {
      if (assetDownloadController) break;
      assetDownloadTask = downloadGameAssets();
      try { status = await assetDownloadTask; } finally { assetDownloadTask = null; }
      break;
    }
    case 'cancelAssetDownload': assetDownloadController?.abort(); status = 'Canceling asset download…'; break;
    case 'clearGameCache': {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Clear game cache?', message: 'Delete downloaded game resources?',
        detail: 'Future loads will download resources again. Your login cookies and app settings are kept.',
        buttons: ['Cancel', 'Clear cache'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response !== 1) break;
      assetDownloadController?.abort();
      if (assetDownloadTask) await assetDownloadTask.catch(() => {});
      await assetCache.clear();
      await game.webContents.session.clearCache();
      status = 'Game cache cleared. Open pages may download resources again.';
      break;
    }
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
    click: (_item, _window, event) => runCommand(command, value, event).catch((error) => { status = error.message; publish(); }),
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
    { label: settings.speed === 99 ? 'Speed (99×)' : 'Speed',
      submenu: choose('speed', settings.speed === 99 ? 10 : settings.speed, SPEED_OPTIONS, (value) => `${value}×`) },
    { label: 'Screenshot', click: () => runCommand('screenshot').catch((error) => { status = error.message; publish(); }) },
    { label: 'Show player info in window title (local)', type: 'checkbox', checked: settings.playerWindowTitle,
      click: () => runCommand('playerWindowTitle').catch(() => { status = 'Could not configure player title'; publish(); }) },
    { label: 'Discord Rich Presence (stable)', submenu: [
      { label: 'Enable', type: 'checkbox', checked: settings.discordPresence,
        click: () => runCommand('discordPresence').catch(() => { status = 'Could not configure Discord presence'; publish(); }) },
      { label: 'Status / player preview…', click: () => runCommand('discordPreview').catch(() => {}) },
      { label: discordPresence?.status || 'Disabled', enabled: false },
    ] },
    { type: 'separator' },
    { label: 'Download game assets…', enabled: !assetDownloadController,
      click: () => runCommand('downloadAssets').catch((error) => { status = error.message; publish(); }) },
    { label: 'Cancel asset download', enabled: !!assetDownloadController,
      click: () => runCommand('cancelAssetDownload').catch((error) => { status = error.message; publish(); }) },
    { label: 'Clear game cache…', click: () => runCommand('clearGameCache').catch((error) => { status = error.message; publish(); }) },
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
function gameFrames(includePopups = false) {
  const found = [];
  function visit(frame) {
    if (!frame) return;
    if (frame.url.startsWith('https://games.mofushippo.com/')) found.push(frame);
    for (const child of frame.frames) visit(child);
  }
  if (game && !game.webContents.isDestroyed()) visit(game.webContents.mainFrame);
  if (includePopups && game && !game.webContents.isDestroyed()) {
    for (const popup of BrowserWindow.getAllWindows()) {
      if (!popup.webContents.isDestroyed() && popup.webContents.session === game.webContents.session)
        visit(popup.webContents.mainFrame);
    }
  }
  return found;
}
function gameFrame() { return gameFrames().at(-1); }
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
async function startPlayerApiDiagnostic() {
  if (playerApiDiagnostic?.active) return 'Player API capture already running';
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', title: 'Player API capture', message: 'Observe game responses for up to three minutes?',
    detail: 'Observes game responses without debugger attachment. Extracts schema-mapped level/energy numeric samples and nickname presence only; nickname values, IDs, tokens and raw bodies are not saved. On save, also scans static protobuf declarations (up to 20 seconds per game frame). No Unity calls or memory writes. Use 1× speed. Start capture, reload, wait for the game home screen, open your profile, then save. Note your displayed level and current stamina for comparison. Starting a new capture discards the previous report.',
    buttons: ['Cancel', 'Start capture'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (response !== 1) return 'Player API capture canceled';
  if (playerApiDiagnostic?.active) return 'Player API capture already running';
  const diagnostic = new PlayerApiFrameDiagnostic(() => gameFrames(true), () => {
    status = 'Player API capture stopped. Save the report from the right-click menu.';
    publish();
  });
  await diagnostic.start();
  playerApiDiagnostic = diagnostic;
  return diagnostic.frames.size
    ? 'Player API observer installed in the game frame. Reload, open your profile, then stop and save.'
    : 'Player API capture waiting for the game frame. Reload and wait for the game home screen before saving.';
}
async function savePlayerApiDiagnostic() {
  if (!playerApiDiagnostic) throw new Error('Start a player API capture first');
  const diagnostic = playerApiDiagnostic;
  const report = await diagnostic.stopAndReport();
  const file = await dialog.showSaveDialog(window, {
    defaultPath: 'criste-player-api-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (file.canceled || !file.filePath) return 'Player API capture stopped. Report is still available to save.';
  status = 'Reading static protobuf schemas from Unity memory… Allow up to 20 seconds per game frame.';
  publish();
  report.protocolSchemas = [];
  for (const frame of gameFrames(true)) {
    try { report.protocolSchemas.push(await frame.executeJavaScript(playerProtocolSchemaScript())); }
    catch { report.protocolSchemas.push({ error: 'Game frame unavailable during schema inspection' }); }
  }
  fs.writeFileSync(file.filePath, JSON.stringify(report, null, 2));
  return `Player API report saved: ${report.responses.length} bodies, ${report.counts.gameRequests} game requests, ${report.counts.webSocketFramesSeen} socket frames. Fields are unverified.`;
}
async function downloadGameAssets() {
  const frame = gameFrame();
  if (!frame) throw new Error('Load the game before downloading its assets');
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', title: 'Download game assets', message: 'Download all discoverable game assets?',
    detail: 'This warms the browser disk cache and keeps a separate asset copy (copy limit: 2 GiB). Loaded resources and readable manifest references are included. Some assets may remain undiscoverable. This may use substantial bandwidth and disk space.',
    buttons: ['Cancel', 'Download'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (response !== 1) return 'Asset download canceled';
  if (assetDownloadController) return 'Asset download already running';
  const controller = new AbortController();
  assetDownloadController = controller;
  let completed = 0, failed = 0;
  try {
    const seen = new Set((await frame.executeJavaScript(gameAssetListScript())).filter(isGameAsset));
    const queue = [...seen];
    const worker = async () => {
      while (queue.length && !controller.signal.aborted) {
        const url = queue.shift();
        try {
          const response = await assetCache.prefetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error('Asset unavailable');
          const isManifest = /\/DefaultPackage_[^/]+\.bytes(?:\?|$)/i.test(url);
          const reader = response.body?.getReader();
          const chunks = []; let length = 0;
          if (reader) {
            try {
              while (true) {
                if (controller.signal.aborted) throw new Error('Canceled');
                const { value, done } = await reader.read();
                if (done) break;
                if (isManifest) {
                  length += value.length;
                  if (length > 16 * 1024 * 1024) throw new Error('Manifest exceeds discovery limit');
                  chunks.push(Buffer.from(value));
                }
              }
            } finally { await reader.cancel().catch(() => {}); }
          }
          if (isManifest) for (const asset of manifestAssets(Buffer.concat(chunks), url)) {
            if (!seen.has(asset) && seen.size < 5000) { seen.add(asset); queue.push(asset); }
          }
          completed++;
        } catch { if (!controller.signal.aborted) failed++; }
        status = `Assets: ${completed} fetched, ${failed} failed, ${queue.length} queued`;
        publish();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await Promise.all([...assetCache.pending]);
    return `${controller.signal.aborted ? 'Download canceled' : 'Asset download finished'}: ${completed} fetched, ${failed} failed. Cache follows origin rules; discovery may be incomplete.`;
  } finally { assetDownloadController = null; }
}
async function inspectStoryRuntime() {
  const frame = gameFrame();
  if (!frame) throw new Error('Open a story before running the runtime probe');
  const file = await dialog.showSaveDialog(window, {
    defaultPath: 'criste-story-runtime-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (file.canceled || !file.filePath) return 'Story runtime probe canceled';
  status = 'Read-only story runtime scan… This can take up to two minutes.';
  publish();
  const report = await frame.executeJavaScript(storyRuntimeProbeScript());
  fs.writeFileSync(file.filePath, JSON.stringify(report, null, 2));
  return report.error || 'Story runtime report saved. Candidate addresses are not verified objects.';
}
async function inspectStoryUi() {
  const frame = gameFrame();
  if (!frame) throw new Error('Open a story in the game before running this diagnostic');
  const file = await dialog.showSaveDialog(window, {
    defaultPath: 'criste-story-ui-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (file.canceled || !file.filePath) return 'Story UI diagnostic canceled';
  status = 'Scanning story UI names in memory… This may take a few seconds.';
  publish();
  const report = await frame.executeJavaScript(storyDiagnosticScript());
  fs.writeFileSync(file.filePath, JSON.stringify({
    note: 'Read-only story UI inspection. No Unity methods were called. No cookies, request headers, full URLs, screenshots or dialogue text are deliberately collected. Review candidate names before sharing.',
    ...report,
  }, null, 2));
  return report.unityReady
    ? 'Story UI report saved. Share the JSON report for inspection.'
    : 'Report saved, but Unity was not ready. Open a story and try again.';
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
  contents.on('did-start-navigation', (_event, url, inPlace, isMainFrame, processId, routingId) => {
    if (!inPlace && (isMainFrame || playerStateMonitor?.owner === processId + ':' + routingId ||
        url.startsWith('https://games.mofushippo.com/'))) playerStateMonitor?.reset();
  });
  contents.on('did-frame-finish-load', (_event, _main, processId, routingId) => {
    playerStateMonitor?.installFrame(webFrameMain.fromId(processId, routingId)).catch(() => {});
  });
  contents.on('did-frame-navigate', (_event, _url, _code, _text, _main, processId, routingId) => {
    playerStateMonitor?.installFrame(webFrameMain.fromId(processId, routingId)).catch(() => {});
  });
  contents.on('render-process-gone', () => playerStateMonitor?.reset());
  contents.on('did-create-window', (popup) => secureWebContents(popup.webContents));
}

function createWindow() {
  window = new BrowserWindow({
    ...settings.bounds,
    minWidth: 760, minHeight: 520,
    title: DEFAULT_WINDOW_TITLE,
    icon: APP_ICON,
    backgroundColor: '#181b25',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  playerTitle = attachPlayerWindowTitle(window);
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
    discordPresence?.stop();
    playerStateMonitor?.stop().catch(() => {});
    if (!window.isMaximized() && !window.isFullScreen()) settings.bounds = window.getBounds();
    save();
  });
  secureWebContents(game.webContents);
  game.webContents.on('render-process-gone', (_event, details) => {
    recordProcessExit('game-renderer', details);
    playerApiDiagnostic?.finish('renderer-exit');
    status = `Game renderer exited: ${details.reason} (${details.exitCode}). Use Reload to retry.`;
    publish();
  });
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
    playerApiDiagnostic?.installFrame(frame).catch(() => {});
    if (settings.bridgeEnabled && frame?.url.startsWith('https://games.mofushippo.com/')) {
      setTimeout(() => { if (settings.bridgeEnabled) sendUnitySpeed(settings.speed).catch(() => {}); }, 5000);
    }
  });
  game.webContents.on('did-frame-navigate', (_event, _url, _code, _text, _isMainFrame, processId, routingId) => {
    playerApiDiagnostic?.installFrame(webFrameMain.fromId(processId, routingId)).catch(() => {});
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
  assetCache = createGameAssetCache(gameSession, path.join(app.getPath('userData'), 'game-assets'));
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
  updatePresence().catch(() => { status = 'Could not start Discord presence'; publish(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { discordPresence?.stop(); playerStateMonitor?.stop().catch(() => {}); });
app.on('child-process-gone', (_event, details) => recordProcessExit(details.type, details));
