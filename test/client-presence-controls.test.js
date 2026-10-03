// Exercise the real main-process settings/menu/commands with isolated mocks.
// Never starts Electron, reads the user's settings, or connects to Discord/game.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const localRequire = createRequire(mainPath);

function fixture(saved) {
  const monitors = [], clients = [], dialogs = [], titlePlayers = [], writes = [];
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
      getPath: () => 'D:\\isolated-client-fixture' },
    Menu: { buildFromTemplate(template) { menu = template; return { popup() {} }; } },
    dialog: { async showMessageBox(_window, options) { dialogs.push(options); return { response }; } },
  };
  const context = vm.createContext({ __dirname: path.dirname(mainPath), console, setTimeout, clearTimeout,
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
      initialize(mockWindow, mockTitle) { settings = readSettings(); window = mockWindow; playerTitle = mockTitle; },
      command: runCommand, showMenu: showClientMenu, state, updatePresence,
      diagnosticsAvailable: () => [inspectStoryUi, inspectStoryRuntime, startPlayerApiDiagnostic, savePlayerApiDiagnostic]
        .every(value => typeof value === 'function'),
    };
  `, context, { filename: mainPath });
  const controls = context.controls;
  controls.initialize({ isDestroyed: () => false, isFullScreen: () => false, webContents: { send() {} } },
    { setPlayer(value) { titlePlayers.push(value); } });
  return { controls, monitors, clients, dialogs, titlePlayers, writes,
    menu() { controls.showMenu(); return menu; }, setResponse(value) { response = value; } };
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
