const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectManagedStoryAssembly } = require('../src/managed-story-metadata');

function fixture() {
  const bytes = Buffer.alloc(4096);
  const w16 = (p, n) => bytes.writeUInt16LE(n, p);
  const w32 = (p, n) => bytes.writeUInt32LE(n, p);
  w16(0, 0x5a4d); w32(60, 128); w32(128, 0x4550);
  w16(134, 1); w16(148, 224); w16(152, 0x10b);
  w32(152 + 96 + 112, 4096);
  w32(376 + 12, 4096); w32(376 + 16, 3584); w32(376 + 20, 512);
  w32(512 + 8, 4160);
  const root = 576;
  w32(root, 0x424a5342); w32(root + 12, 12);
  bytes.write('v4.0.30319\0', root + 16, 'ascii'); w16(root + 30, 3);
  let cursor = root + 32;
  for (const [name, offset, size] of [['#~', 128, 100], ['#Strings', 256, 256], ['#Blob', 512, 32]]) {
    w32(cursor, offset); w32(cursor + 4, size);
    bytes.write(name + '\0', cursor + 8, 'ascii');
    cursor += 8 + ((name.length + 4) & ~3);
  }
  const tables = root + 128;
  w32(tables + 8, 0x45); // Module, TypeDef, MethodDef
  w32(tables + 24, 1); w32(tables + 28, 1); w32(tables + 32, 1);
  const type = tables + 36 + 10;
  w16(type + 4, 1); w16(type + 10, 1); w16(type + 12, 1);
  const method = type + 14;
  w16(method + 6, 6); w16(method + 8, 11); w16(method + 10, 1); w16(method + 12, 1);
  bytes.write('\0UIPlotWin\0SetPlotDialogPanelVisible\0', root + 256, 'ascii');
  bytes.set([0, 4, 0x20, 1, 1, 2], root + 512);
  return bytes;
}

test('reads owning type and bool signature without executing managed code', () => {
  const report = inspectManagedStoryAssembly(fixture(), 0);
  assert.equal(report.methods[0].type, 'UIPlotWin');
  assert.equal(report.methods[0].method, 'SetPlotDialogPanelVisible');
  assert.equal(report.methods[0].static, false);
  assert.equal(report.uiTypes[0].type, 'UIPlotWin');
  assert.deepEqual(report.uiTypes[0].fields, []);
  assert.deepEqual(report.methods[0].signature,
    { parameterCount: 1, returnType: 'void', parameterTypes: ['bool'], fullyDecoded: true });
});

test('rejects invalid and truncated PE images', () => {
  assert.equal(inspectManagedStoryAssembly(new Uint8Array(64), 0), null);
  assert.equal(inspectManagedStoryAssembly(fixture().subarray(0, 600), 0), null);
});

test('reports IL references without executing or including string values', () => {
  const bytes = fixture();
  const method = 576 + 128 + 36 + 10 + 14;
  bytes.writeUInt32LE(4096 + 2000 - 512, method);
  // Tiny method: ldarg.0; ldarg.1; call MethodDef 1; ret.
  bytes.set([34, 2, 3, 0x28, 1, 0, 0, 6, 0x2a], 2000);
  const body = inspectManagedStoryAssembly(bytes, 0).methods[0].body;
  assert.equal(body.truncated, false);
  assert.deepEqual(body.instructions[2].reference,
    { type: 'UIPlotWin', method: 'SetPlotDialogPanelVisible' });
  assert.equal(body.instructions[3].opcode, 'ret');
});

function protocolFixture() {
  const bytes = fixture();
  const root = 576, tables = root + 128;
  const w16 = (at, value) => bytes.writeUInt16LE(value, at);
  const w32 = (at, value) => bytes.writeUInt32LE(value, at);
  let cursor = root + 32;
  for (const [name, offset, size] of [['#~', 128, 192], ['#Strings', 384, 384], ['#Blob', 896, 128]]) {
    w32(cursor, offset); w32(cursor + 4, size);
    bytes.write(name + '\0', cursor + 8);
    cursor += 8 + ((name.length + 4) & ~3);
  }
  bytes.fill(0, tables, tables + 192);
  w32(tables + 8, (1 << 0) | (1 << 2) | (1 << 4) | (1 << 11));
  [1, 2, 6, 3].forEach((count, i) => w32(tables + 24 + i * 4, count));
  bytes.fill(0, root + 384, root + 768);
  let nextString = 1;
  const str = (value) => {
    const index = nextString;
    bytes.write(value + '\0', root + 384 + index);
    nextString += value.length + 1;
    return index;
  };
  const module = tables + 40, typeStart = module + 10, fieldStart = typeStart + 28, constantStart = fieldStart + 36;
  w16(module + 2, str('Protocol.dll'));
  const namespace = str('Game.Protocol');
  for (const [i, name, firstField] of [[0, 'ServerResponse', 1], [1, 'PlayerInfo', 3]]) {
    const at = typeStart + i * 14;
    w16(at + 4, str(name)); w16(at + 6, namespace);
    w16(at + 10, firstField); w16(at + 12, 1);
  }
  const blob = root + 896;
  bytes.fill(0, blob, blob + 128);
  bytes.set([4, 101, 0, 0, 0], blob + 1);
  bytes.set([3, 6, 18, 8], blob + 6); // field signature: class TypeDef row 2
  bytes.set([4, 2, 0, 0, 0], blob + 10);
  bytes.set([2, 6, 8], blob + 15); // field signature: int32
  bytes.set([4, 1, 0, 0, 0], blob + 18);
  bytes.set([2, 6, 14], blob + 23); // field signature: string
  for (const [i, name, flags, signature] of [
    [0, 'UserInfoFieldNumber', 0x8056, 15], [1, 'userInfo_', 1, 6],
    [2, 'LevelFieldNumber', 0x8056, 15], [3, 'level_', 1, 15],
    [4, 'NicknameFieldNumber', 0x8056, 15], [5, 'nickname_', 1, 23],
  ]) {
    const at = fieldStart + i * 6;
    w16(at, flags); w16(at + 2, str(name)); w16(at + 4, signature);
  }
  for (const [i, fieldRow, blobIndex] of [[0, 1, 1], [1, 3, 10], [2, 5, 18]]) {
    const at = constantStart + i * 6;
    w16(at, 8); w16(at + 2, fieldRow << 2); w16(at + 4, blobIndex);
  }
  return bytes;
}

test('protocol metadata maps observed envelope tags to typed player fields without calls', () => {
  const bytes = protocolFixture(), before = Buffer.from(bytes);
  const report = inspectManagedStoryAssembly(bytes, 0, 'player-protocol');
  assert.equal(report.moduleName, 'Protocol.dll');
  const envelope = report.protocolTypes.find((type) => type.type === 'ServerResponse');
  assert.deepEqual(envelope.fields[0], { name: 'UserInfo', number: 101, valueType: 'message',
    messageType: { type: 'PlayerInfo', namespace: 'Game.Protocol' } });
  const player = report.protocolTypes.find((type) => type.type === 'PlayerInfo');
  assert.deepEqual(player.fields, [
    { name: 'Level', number: 2, valueType: 'int32' },
    { name: 'Nickname', number: 1, valueType: 'string' },
  ]);
  assert.deepEqual(bytes, before);
});

test('protocol schema probe extracts only metadata and handles missing Unity', async () => {
  const vm = require('node:vm');
  const { playerProtocolSchemaScript } = require('../src/player-protocol-schema');
  const bytes = protocolFixture(), before = Buffer.from(bytes);
  const report = await vm.runInNewContext(playerProtocolSchemaScript(), {
    window: { unityInstance: { Module: { HEAPU8: bytes } } }, setTimeout,
  });
  assert.equal(report.assemblies[0].protocolTypes.length, 2);
  assert.equal(report.stoppedEarly, false);
  assert.deepEqual(bytes, before);
  const missing = await vm.runInNewContext(playerProtocolSchemaScript(), { window: {} });
  assert.match(missing.error, /not visible/);
});
