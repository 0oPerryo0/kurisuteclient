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
