// Exercise the real main-process settings/menu/commands with isolated mocks.
// Never starts Electron, reads the user's settings, or connects to Discord/game.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const localRequire = createRequire(mainPath);

function fixture(saved) {
  const monitors = [], clients = [], dialogs = [], titlePlayers = [], writes = [], titleUpdates = [], releaseChecks = [];
  let latestRelease = null, assetBytes = Buffer.alloc(0);
  const env = {};
  let menu, response = 1;
  class Monitor {
    constructor(getFrames, onState, options) {
      Object.assign(this, { getFrames, onState, options }); monitors.push(this);
    }
    async start() { this.active = true; }
    async stop() { this.active = false; this.onState(null); }
    emitPlayer(player) { this.player = player; this.onState(player); }
    snapshot() { return this.player || null; }
  }
  class Presence {
    constructor() { this.players = []; this.status = 'Disabled'; clients.push(this); }
    start() { this.active = true; }
    stop() { this.active = false; this.players = []; }
    setPlayer(player, shareName) { this.players.push({ player, shareName }); }
  }
  const electron = {
    app: { commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on() {},
      getPath: () => 'D:\\isolated-client-fixture', getVersion: () => '0.0.7' },
    // GitHub's latest-release API, answered locally.
    net: { async fetch(url) {
      if (!url.startsWith('https://api.github.com/')) {
        return { ok: true, status: 200, body: (async function* () { for (let i = 0; i < assetBytes.length; i += 4) yield assetBytes.subarray(i, i + 4); })() };
      }
      releaseChecks.push(url);
      return { ok: !!latestRelease, status: latestRelease ? 200 : 404, json: async () => latestRelease }; } },
    shell: { showItemInFolder() {}, async openPath() { return ''; }, async openExternal() {} },
    Menu: { buildFromTemplate(template) { menu = template; return { popup() {} }; } },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: { async showMessageBox(_window, options) { dialogs.push(options); return { response }; } },
  };
  const context = vm.createContext({ __dirname: path.dirname(mainPath), console, setTimeout, clearTimeout,
    process: { env }, Buffer,
    setInterval, clearInterval, module: { exports: {} }, require(id) {
      if (id === 'electron') return electron;
      if (id === 'node:fs') return {
        readFileSync() { if (saved === undefined) throw new Error('No settings'); return JSON.stringify(saved); },
        mkdirSync() {}, writeFileSync(_file, text) { writes.push(JSON.parse(text)); },
      };
      if (id === './player-state-monitor') return { PlayerStateMonitor: Monitor };
      if (id === './discord-presence') return { DiscordPresence: Presence, DISCORD_APPLICATION_ID: '1555289041614807061' };
      return localRequire(id);
    } });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8') + `
    globalThis.controls = {
      initialize(mockWindow, mockTitle, mockGame) { settings = readSettings(); window = mockWindow; playerTitle = mockTitle; game = mockGame; },
      command: runCommand, showMenu: showClientMenu, state, updatePresence,
      diagnosticsAvailable: () => [inspectStoryUi, inspectStoryRuntime, startPlayerApiDiagnostic, savePlayerApiDiagnostic]
        .every(value => typeof value === 'function'),
    };
  `, context, { filename: mainPath });
  const controls = context.controls;
  const reloads = [];
  controls.initialize({ isDestroyed: () => false, isFullScreen: () => false, webContents: { send() {} } },
    { setPlayer(value) { titlePlayers.push(value); }, setUpdateNotice(value) { titleUpdates.push(value); } },
    { webContents: { reload() { reloads.push(true); } } });
  return { controls, monitors, clients, dialogs, titlePlayers, writes, reloads, titleUpdates, releaseChecks,
    menu() { controls.showMenu(); return menu; }, setResponse(value) { response = value; },
    setLatestRelease(value) { latestRelease = value; }, setAsset(bytes) { assetBytes = bytes; },
    useDownloadFolder() { return (env.PORTABLE_EXECUTABLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'criste-client-update-'))); } };
}

test('client menu hides diagnostics and separate nickname/refresh switches while labelling presence stable', () => {
  const f = fixture();
  const menu = f.menu(), presence = menu.find(item => item.label === 'Discord Rich Presence (stable)');
  assert.ok(presence);
  assert.deepEqual(Array.from(presence.submenu, item => item.label), ['Enable', 'Status / player preview…', 'Disabled']);
  const labels = Array.from(menu, item => item.label || '').join('\n');
  assert.doesNotMatch(labels, /story.*diagnostic|story.*runtime|player API|refresh player data|share in-game nickname/i);
  assert.equal(f.controls.diagnosticsAvailable(), true, 'Hide controls without deleting diagnostic implementations');
});

test('one Enable consent turns on nickname and automatic player refresh; disabling stops both', async () => {
  const f = fixture();
  await f.controls.command('discordPresence');
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].message, /nickname, level and stamina/);
  assert.match(f.dialogs[0].detail, /one-minute player refresh/);
  assert.match(f.dialogs[0].detail, /gameplay-triggered/);
  assert.match(f.dialogs[0].detail, /not been independently verified to be side-effect-free/);
  assert.equal(f.controls.state().discordPresence, true);
  assert.equal(f.monitors[0].options.shareName, true);
  assert.equal(f.monitors[0].options.polling, true);
  assert.equal(f.clients[0].active, true);
  const player = { nickname: 'PRIVATE_NAME', level: 96, stamina: 279 };
  f.monitors[0].emitPlayer(player);
  assert.equal(f.clients[0].players.at(-1).shareName, true);
  assert.equal(f.titlePlayers.at(-1).nickname, 'PRIVATE_NAME');
  assert.equal(JSON.stringify(f.writes).includes('PRIVATE_'), false);
  assert.equal('discordShareName' in f.writes[0], false);
  assert.equal('discordPlayerPolling' in f.writes[0], false);
  await f.controls.command('discordPresence');
  assert.equal(f.dialogs.length, 1, 'Disabling does not ask for another consent');
  assert.equal(f.controls.state().discordPresence, false);
  assert.equal(f.clients[0].active, false);
  assert.equal(f.monitors[0].active, false);
  assert.equal(f.monitors[1].options.polling, false, 'A local-only title cannot send refresh requests');
  f.monitors[1].emitPlayer(player);
  assert.equal(f.clients[0].players.length, 0);
  assert.equal(f.titlePlayers.at(-1).nickname, 'PRIVATE_NAME', 'Local title remains independent of Discord');
});

test('cancelling Enable leaves nickname sharing and server refresh off', async () => {
  const f = fixture(); f.setResponse(0);
  await f.controls.command('discordPresence');
  assert.equal(f.controls.state().discordPresence, false);
  assert.equal(f.monitors.length, 0);
  assert.equal(f.clients.length, 0);
});

test('saved Enable state governs refresh and nickname without obsolete split settings', async () => {
  const f = fixture({ discordPresence: true, discordShareName: false, discordPlayerPolling: false, playerWindowTitle: false });
  await f.controls.updatePresence();
  assert.equal(f.monitors[0].options.polling, true);
  assert.equal(f.monitors[0].options.shareName, true);
  assert.equal('discordShareName' in f.controls.state(), false);
  assert.equal('discordPlayerPolling' in f.controls.state(), false);
  f.monitors[0].emitPlayer({ nickname: 'PRIVATE_NAME', level: 96, stamina: 279 });
  assert.equal(f.titlePlayers.at(-1), null, 'Keep the local-title preference');
  assert.equal(f.clients[0].players.at(-1).shareName, true);
  await assert.rejects(f.controls.command('discordShareName'), /Unknown command/);
  await assert.rejects(f.controls.command('discordPlayerPolling'), /Unknown command/);
});

test('game language is opt-in: Japanese by default, consent before the first switch, then reload', async () => {
  const f = fixture();
  const language = f.menu().find(item => item.label === 'Game language (experimental)');
  assert.deepEqual(Array.from(language.submenu, item => [item.label, item.checked]),
    [['日本語 (original)', true], ['简体中文', false], ['繁體中文（台灣，劇情保留原文）', false]]);
  f.setResponse(0);
  await f.controls.command('gameLanguage', 'zh');
  assert.equal(f.controls.state().gameLanguage, 'ja');
  assert.equal(f.reloads.length, 0);
  f.setResponse(1);
  await f.controls.command('gameLanguage', 'zh');
  assert.equal(f.dialogs.length, 2);
  assert.match(f.dialogs[1].detail, /may violate the service terms/);
  assert.match(f.dialogs[1].detail, /story dialogue stays in the original Simplified Chinese/);
  assert.equal(f.controls.state().gameLanguage, 'zh');
  assert.equal(f.writes.at(-1).gameLanguage, 'zh');
  assert.equal(f.reloads.length, 1);
  await f.controls.command('gameLanguage', 'tw');
  assert.equal(f.controls.state().gameLanguage, 'tw');
  await f.controls.command('gameLanguage', 'ja');
  assert.equal(f.dialogs.length, 2, 'Switching between patched languages or back to Japanese needs no consent');
  assert.equal(f.controls.state().gameLanguage, 'ja');
  assert.equal(f.reloads.length, 3);
  await f.controls.command('gameLanguage', 'en');
  await f.controls.command('gameLanguage', 'xx');
  assert.equal(f.controls.state().gameLanguage, 'ja');
});

test('update checks are on by default and listed in an Updates submenu', async () => {
  const f = fixture();
  const updates = f.menu().find(item => item.label === 'Updates');
  assert.deepEqual(Array.from(updates.submenu, item => item.label), ['Not checked yet', 'Check now', 'Check automatically']);
  assert.equal(updates.submenu[2].checked, true);
  await f.controls.command('updateCheck');
  assert.equal(f.controls.state().updateCheck, false);
  assert.equal(f.writes.at(-1).updateCheck, false);
  assert.equal(fixture({ updateCheck: false }).controls.state().updateCheck, false);
});

test('saved game language is validated', () => {
  assert.equal(fixture({ gameLanguage: 'zh' }).controls.state().gameLanguage, 'zh');
  assert.equal(fixture({ gameLanguage: 'constructor' }).controls.state().gameLanguage, 'ja');
  assert.equal(fixture({ gameLanguage: 'en' }).controls.state().gameLanguage, 'ja', 'English is no longer offered');
});

test('obtaining player data checks for updates and marks the title, at most every 10 minutes', async () => {
  const f = fixture({ playerWindowTitle: true });
  f.setLatestRelease({ tag_name: '0.0.8', draft: false, prerelease: false, assets: [] });
  await f.controls.updatePresence();
  f.monitors[0].emitPlayer({ nickname: 'Perry', level: 96, stamina: 279 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.releaseChecks.length, 1);
  assert.equal(f.titleUpdates.at(-1), 'New update is available');
  assert.equal(f.menu().find(item => item.label === 'Updates (0.0.8 available)').submenu[0].label, 'Version 0.0.8 is available');
  f.monitors[0].emitPlayer({ nickname: 'Perry', level: 96, stamina: 280 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.releaseChecks.length, 1, 'Frequent player refreshes do not re-query GitHub');
});

test('player data does not check for updates when automatic checks are off', async () => {
  const f = fixture({ playerWindowTitle: true, updateCheck: false });
  await f.controls.updatePresence();
  f.monitors[0].emitPlayer({ nickname: 'Perry', level: 96, stamina: 279 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.releaseChecks.length, 0);
});

test('downloading an update shows its progress in the title instead of the update notice', async () => {
  const f = fixture({ playerWindowTitle: true });
  const downloads = f.useDownloadFolder();
  try {
    const exe = Buffer.alloc(16, 1);
    f.setAsset(exe);
    f.setLatestRelease({ tag_name: '0.0.8', draft: false, prerelease: false, assets: [{ name: 'CristeDesktop-0.0.8.exe',
      browser_download_url: 'https://github.com/0oPerryo0/kurisuteclient/releases/download/0.0.8/CristeDesktop-0.0.8.exe', size: exe.length }] });
    await f.controls.command('checkUpdates');
    f.setResponse(0);
    await f.controls.command('downloadUpdate');
    assert.deepEqual(f.titleUpdates.filter((value, index, all) => value !== all[index - 1]), ['New update is available',
      'Downloading update 0%', 'Downloading update 25%', 'Downloading update 50%', 'Downloading update 75%',
      'Downloading update 100%', 'Update downloaded']);
    assert.deepEqual(fs.readFileSync(path.join(downloads, 'CristeDesktop-0.0.8.exe')), exe);
  } finally { fs.rmSync(downloads, { recursive: true, force: true }); }
});

test('a failed update download returns the title to the update notice', async () => {
  const f = fixture({ playerWindowTitle: true });
  const downloads = f.useDownloadFolder();
  try {
    f.setAsset(Buffer.alloc(4));
    f.setLatestRelease({ tag_name: '0.0.8', draft: false, prerelease: false, assets: [{ name: 'CristeDesktop-0.0.8.exe',
      browser_download_url: 'https://github.com/0oPerryo0/kurisuteclient/releases/download/0.0.8/CristeDesktop-0.0.8.exe', size: 16 }] });
    await f.controls.command('checkUpdates');
    await assert.rejects(f.controls.command('downloadUpdate'), /incomplete/);
    assert.equal(f.titleUpdates.at(-1), 'New update is available');
  } finally { fs.rmSync(downloads, { recursive: true, force: true }); }
});
