const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractMetadata, parseMetadata } = require('../src/il2cpp-metadata');

test('extracts bounded global-metadata.dat entry from UnityWebData', () => {
  const name = Buffer.from('Il2CppData/Metadata/global-metadata.dat');
  const header = 16 + 4 + 12 + name.length;
  const archive = Buffer.alloc(header + 4);
  archive.write('UnityWebData1.0\0');
  archive.writeUInt32LE(header, 16);
  archive.writeUInt32LE(header, 20);
  archive.writeUInt32LE(4, 24);
  archive.writeUInt32LE(name.length, 28);
  name.copy(archive, 32);
  archive.write('test', header);
  assert.equal(extractMetadata(archive).toString(), 'test');
  archive.writeUInt32LE(archive.length + 1, 20);
  assert.throws(() => extractMetadata(archive), /bounds/);
});

test('identifies an IL2CPP method and its declaring assembly', () => {
  const data = Buffer.alloc(1024);
  data.writeUInt32LE(0xfab11baf, 0);
  data.writeInt32LE(29, 4);
  const names = ['TimeCommands', 'SetTimeScale', 'Assembly-CSharp.dll', 'scale'];
  const indices = {};
  let cursor = 512;
  for (const name of names) {
    indices[name] = cursor - 512;
    cursor += data.write(name + '\0', cursor);
  }
  // Metadata header: string, methods, parameters, typeDefinitions, images.
  const tables = [[2, 512, cursor - 512], [5, 600, 32], [10, 640, 12],
    [19, 680, 88], [20, 800, 40]];
  for (const [index, offset, size] of tables) {
    data.writeUInt32LE(offset, 8 + index * 8);
    data.writeUInt32LE(size, 12 + index * 8);
  }
  data.writeUInt32LE(indices.SetTimeScale, 600);
  data.writeUInt16LE(0x16, 624); // public static
  data.writeUInt16LE(1, 630);
  data.writeUInt32LE(indices.scale, 640);
  data.writeInt32LE(123, 648);
  data.writeUInt32LE(indices.TimeCommands, 680);
  data.writeUInt16LE(1, 680 + 64);
  data.writeUInt32LE(indices['Assembly-CSharp.dll'], 800);
  data.writeUInt32LE(1, 812);
  const parsed = parseMetadata(data);
  assert.equal(parsed.version, 29);
  assert.equal(parsed.bridge.sendMessage, false);
  assert.equal(parsed.bridge.static, true);
  assert.deepEqual(parsed.declarations[0], {
    assembly: 'Assembly-CSharp.dll', namespace: 'TimeCommands',
    type: 'TimeCommands', method: 'SetTimeScale', static: true, public: true,
    returnTypeIndex: 0, parameters: [{ name: 'scale', typeIndex: 123 }],
  });
});
