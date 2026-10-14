const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LANGUAGES, bundleKind, patchesBundle, siblingBundleUrl, patchUrl, originalUrl, findGameConfigs, patchSceneBundle,
  readTable, writeTable, storyTextIds, traditionalConverter, pickCoverage, convertLanguageTable, patchTableBundle,
} = require('../src/game-language');
const { lz4Block, readBundle, readTextAssets, replaceTextAssets, fontCoverage } = require('../src/unity-bundle');

const BASE = 'https://crystal-test1.oss-cn-beijing.aliyuncs.com/resouce-dev-aws/';

// A valid LZ4 block made of one literal-only sequence.
function lz4Literals(bytes) {
  const length = bytes.length, extra = [];
  if (length >= 15) { let rest = length - 15; while (rest >= 255) { extra.push(255); rest -= 255; } extra.push(rest); }
  return Buffer.concat([Buffer.from([Math.min(length, 15) << 4, ...extra]), bytes]);
}

function gameConfig(language, server = 3) {
  const bytes = Buffer.alloc(28);
  [server, 2, 10001, language, 0, 0, 1].forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
}

// UnityFS with LZ4 block info and two data blocks, the first LZ4-compressed, behind YooAsset padding.
function unityFs(nodes, splitAt) {
  const data = Buffer.concat(nodes.map((node) => node.bytes));
  const parts = [data.subarray(0, splitAt), data.subarray(splitAt)];
  const stored = [lz4Literals(parts[0]), parts[1]];
  const table = Buffer.alloc(4 + parts.length * 10);
  table.writeInt32BE(parts.length, 0);
  parts.forEach((part, index) => {
    table.writeUInt32BE(part.length, 4 + index * 10);
    table.writeUInt32BE(stored[index].length, 8 + index * 10);
    table.writeUInt16BE(index === 0 ? 3 : 0, 12 + index * 10);
  });
  let offset = 0;
  const nodeTable = [Buffer.from([0, 0, 0, nodes.length])];
  for (const node of nodes) {
    const entry = Buffer.alloc(20);
    entry.writeBigInt64BE(BigInt(offset), 0); entry.writeBigInt64BE(BigInt(node.bytes.length), 8); entry.writeUInt32BE(4, 16);
    nodeTable.push(entry, Buffer.from(node.name + '\0', 'latin1'));
    offset += node.bytes.length;
  }
  const info = Buffer.concat([Buffer.alloc(16, 7), table, ...nodeTable]);
  const packedInfo = lz4Literals(info);
  const header = Buffer.concat([Buffer.from('UnityFS\0', 'latin1'), Buffer.from([0, 0, 0, 8]),
    Buffer.from('5.x.x\0' + '2022.3.34f1c1\0', 'latin1')]);
  const headerLength = (header.length + 20 + 15) & ~15;
  const dataStart = (headerLength + packedInfo.length + 15) & ~15;
  const output = Buffer.alloc(dataStart + stored[0].length + stored[1].length);
  header.copy(output);
  output.writeBigInt64BE(BigInt(output.length), header.length);
  output.writeUInt32BE(packedInfo.length, header.length + 8);
  output.writeUInt32BE(info.length, header.length + 12);
  output.writeUInt32BE(0x243, header.length + 16);
  packedInfo.copy(output, headerLength);
  Buffer.concat(stored).copy(output, dataStart);
  return Buffer.concat([Buffer.alloc(42), output]);
}

const nodeData = (bundle) => Object.fromEntries(readBundle(bundle).nodes.map((node) => [node.name, node.bytes]));

function table(rows) {
  return writeTable({ count: rows.length, columns: rows[0].length, rows });
}

// Format 22 serialized file holding TextAssets, as Unity writes them for table bundles.
function serialized(assets) {
  const pad = (n) => Buffer.alloc((4 - (n % 4)) % 4);
  const bodies = assets.map(([name, script]) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(4); head.writeInt32LE(nameBytes.length, 0);
    const length = Buffer.alloc(4); length.writeInt32LE(script.length, 0);
    return Buffer.concat([head, nameBytes, pad(nameBytes.length), length, script, pad(script.length)]);
  });
  const type = Buffer.alloc(7 + 16); type.writeInt32LE(49, 0); type.writeInt16LE(-1, 5);
  const counts = Buffer.alloc(9); counts.writeInt32LE(20, 0); counts.writeInt32LE(1, 5);
  const objectCount = Buffer.alloc(4); objectCount.writeInt32LE(assets.length, 0);
  let meta = Buffer.concat([Buffer.from('2022.3.34f1c1\0', 'latin1'), counts, type, objectCount]);
  meta = Buffer.concat([meta, pad(48 + meta.length)]);
  const entries = [];
  let start = 0;
  bodies.forEach((body, index) => {
    const entry = Buffer.alloc(24);
    entry.writeBigInt64LE(BigInt(index + 1), 0); entry.writeBigInt64LE(BigInt(start), 8); entry.writeUInt32LE(body.length, 16);
    entries.push(entry);
    start = Math.ceil((start + body.length) / 8) * 8;
  });
  const metadata = Buffer.concat([meta, ...entries, Buffer.alloc(13)]);
  const dataOffset = Math.ceil((48 + metadata.length) / 16) * 16;
  const data = [];
  let position = 0;
  for (const body of bodies) {
    const at = Math.ceil(position / 8) * 8;
    data.push(Buffer.alloc(at - position), body);
    position = at + body.length;
  }
  const header = Buffer.alloc(48);
  header.writeUInt32BE(22, 8); header.writeUInt32BE(metadata.length, 20);
  header.writeBigInt64BE(BigInt(dataOffset + position), 24); header.writeBigInt64BE(BigInt(dataOffset), 32);
  return Buffer.concat([header, metadata, Buffer.alloc(dataOffset - 48 - metadata.length), ...data]);
}

const languageTable = () => table([
  ['索引', '', '中文', '', '', '是否重复', '检索用'],
  ['notes', '', '', '日语', '', '', ''],
  ['ID', '', 'CN', 'JP', 'EN', 'IsCommon', ''],
  ['string', '', 'string', 'string', '', 'string', ''],
  ['Confirm', '', '确认', '確認', '', '', ''],
  ['Line1', '', '这是剧情', 'これは物語', '', '', ''],
  ['Name', '', '库拉', 'キュラ', '', '', ''],
]);
const storyTable = () => table([
  ['ID', '下一句ID', '说话', '对话内容ID'], ['', '', '', ''], ['ID', 'NextID', 'ScenarioName', 'ScenarioText'],
  ['string', 'string', 'string', 'string'], ['1', '', 'Name', 'Line1'],
]);
const fakeConverters = {
  toTaiwan: (text) => text.replace(/确认/g, '確認').replace(/这是剧情/g, '這是劇情').replace(/库/g, '庫').replace(/说/g, '說'),
  toJapanese: (char) => ({ 說: '説' })[char] || char,
  toSimplified: (char) => ({ 說: '说', 庫: '库', 確: '确', 認: '认' })[char] || char,
};

test('decodes LZ4 literal runs and overlapping matches', () => {
  assert.equal(lz4Block(Buffer.from([0x35, 0x61, 0x62, 0x63, 3, 0, 0x00]), 12).toString(), 'abcabcabcabc');
  assert.deepEqual(lz4Block(lz4Literals(Buffer.alloc(300, 9)), 300), Buffer.alloc(300, 9));
  assert.throws(() => lz4Block(Buffer.from([0x15, 0x61, 9, 0]), 6), /Corrupt/);
});

test('finds GameConfig serialization by its channel and enum ranges only', () => {
  const bytes = Buffer.concat([Buffer.alloc(8), gameConfig(2), gameConfig(2).fill(0x80, 16, 20)]);
  assert.deepEqual(findGameConfigs(bytes), [8 + 12]);
});

test('patches only the scene GameConfig language and keeps every other byte', () => {
  const shared = Buffer.concat([Buffer.alloc(4), gameConfig(2, 1), Buffer.from('tail')]);
  const scene = Buffer.concat([Buffer.alloc(12), gameConfig(2), Buffer.alloc(8)]);
  // Split inside the language field so it straddles the compressed and stored blocks.
  const bundle = unityFs([{ name: 'BuildPlayer-Home.sharedAssets', bytes: shared }, { name: 'BuildPlayer-Home', bytes: scene }],
    shared.length + 26);
  const result = patchSceneBundle(bundle, 'tw');
  assert.equal(result.patched, 1);
  assert.deepEqual(result.bytes.subarray(0, 42), Buffer.alloc(42), 'padding prefix is kept');
  const nodes = nodeData(result.bytes), expected = Buffer.from(scene);
  expected.writeUInt32LE(LANGUAGES.tw.value, 24);
  assert.deepEqual(nodes['BuildPlayer-Home'], expected);
  assert.deepEqual(nodes['BuildPlayer-Home.sharedAssets'], shared);
  assert.throws(() => patchSceneBundle(unityFs([{ name: 'BuildPlayer-Home', bytes: Buffer.alloc(64) }], 32), 'zh'), /not found/);
  assert.throws(() => patchSceneBundle(Buffer.concat([Buffer.from([1]), bundle]), 'zh'), /Unrecognized/);
  assert.throws(() => patchSceneBundle(bundle, 'xx'), /Unknown language/);
});

test('game tables round-trip and keep their declared row count', () => {
  const bytes = languageTable();
  const parsed = readTable(bytes);
  assert.equal(parsed.rows.length, 7);
  assert.deepEqual(writeTable({ ...parsed, count: 6 }).subarray(4), bytes.subarray(4));
  assert.throws(() => readTable(Buffer.concat([bytes, Buffer.from([0x7f, 0x7f])])), /Corrupt/);
});

test('story dialogue IDs come from every ScenarioText column', () => {
  const assets = new Map([['Story1', storyTable()], ['Language', languageTable()], ['Bad', Buffer.alloc(3)]]);
  assert.deepEqual([...storyTextIds(assets)], ['Line1']);
});

test('Taiwan conversion falls back to Japanese, then Simplified forms the game font can draw', () => {
  const coverage = new Set([...'確認這是劇情说'].map((char) => char.codePointAt(0)));
  const convert = traditionalConverter(fakeConverters, coverage);
  assert.equal(convert('确认 {0} <b>说</b>'), '確認 {0} <b>说</b>');
  coverage.add('説'.codePointAt(0));
  assert.equal(convert('说'), '説');
  assert.equal(convert('库'), '庫', 'nothing drawable, so the conversion is kept as is');
  coverage.add('库'.codePointAt(0));
  assert.equal(convert('库'), '库');
  assert.equal(traditionalConverter(fakeConverters, null)('库'), '庫');
  const fonts = [new Set([0x5e93]), new Set([0x786e, 0x8ba4])];
  assert.equal(pickCoverage(fonts, '确认确认'), fonts[1]);
});

test('converts UI rows, keeps story lines, and preserves the original for prefab lookups', () => {
  const result = convertLanguageTable(languageTable(), new Set(['Line1']), () => traditionalConverter(fakeConverters, null));
  const rows = readTable(result.bytes).rows;
  assert.equal(result.converted, 2);
  assert.deepEqual(rows[4], ['Confirm', '', '確認', '確認', '', '确认', '']);
  assert.deepEqual(rows[5], ['Line1', '', '这是剧情', 'これは物語', '', '', '']);
  assert.deepEqual(rows[6], ['Name', '', '庫拉', 'キュラ', '', '库拉', '']);
  assert.throws(() => convertLanguageTable(storyTable(), new Set(), () => (text) => text), /layout/);
});

test('replaces a TextAsset and realigns the objects after it', () => {
  const file = serialized([['Story1', storyTable()], ['Language', languageTable()], ['Tail', Buffer.from('tail data')]]);
  assert.deepEqual([...readTextAssets(file).keys()], ['Story1', 'Language', 'Tail']);
  const longer = Buffer.concat([languageTable(), Buffer.from('xyz')]);
  const { bytes, changed } = replaceTextAssets(file, new Map([['Language', longer]]));
  assert.equal(changed, 1);
  const assets = readTextAssets(bytes);
  assert.deepEqual(assets.get('Language'), longer);
  assert.deepEqual(assets.get('Tail'), Buffer.from('tail data'));
  assert.deepEqual(assets.get('Story1'), storyTable());
  assert.equal(Number(bytes.readBigInt64BE(24)), bytes.length);
});

test('table bundle conversion touches only the Language table', () => {
  const bundle = unityFs([{ name: 'CAB-tables', bytes: serialized([['Story1', storyTable()], ['Language', languageTable()]]) }], 100);
  let sample;
  const result = patchTableBundle(bundle, (text) => { sample = text; return traditionalConverter(fakeConverters, null); });
  assert.equal(sample, '确认库拉', 'font choice is based on the UI text that will be converted');
  assert.equal(result.converted, 2);
  const assets = readTextAssets(nodeData(result.bytes)['CAB-tables']);
  assert.deepEqual(assets.get('Story1'), storyTable());
  assert.equal(readTable(assets.get('Language')).rows[4][2], '確認');
  const noLanguage = unityFs([{ name: 'CAB-x', bytes: serialized([['Story1', storyTable()]]) }], 50);
  assert.throws(() => patchTableBundle(noLanguage, () => (text) => text), /not found/);
});

test('reads character coverage from embedded TrueType cmap tables', () => {
  const tags = ['cmap', 'head', 'hhea', 'name', 'post'];
  const cmap = 12 + tags.length * 16;
  const font = Buffer.alloc(cmap + 40);
  font.writeUInt32BE(0x00010000, 0); font.writeUInt16BE(tags.length, 4);
  tags.forEach((tag, index) => { font.write(tag, 12 + index * 16, 'latin1'); font.writeUInt32BE(cmap, 20 + index * 16); });
  // One format 12 subtable covering 确 (U+786E) through U+7870.
  font.writeUInt16BE(1, cmap + 2); font.writeUInt16BE(3, cmap + 4); font.writeUInt16BE(10, cmap + 6); font.writeUInt32BE(12, cmap + 8);
  font.writeUInt16BE(12, cmap + 12); font.writeUInt32BE(1, cmap + 24);
  font.writeUInt32BE(0x786e, cmap + 28); font.writeUInt32BE(0x7870, cmap + 32);
  const [coverage] = fontCoverage(Buffer.concat([Buffer.from('padding'), font]));
  assert.deepEqual([...coverage], [0x786e, 0x786f, 0x7870]);
});

test('redirects the scene bundle for any patched language and the table bundle only for Traditional Chinese', () => {
  const scene = BASE + 'defaultpackage_assets_localresources_scene.bundle?t=639275514144400000';
  const tableUrl = BASE + 'defaultpackage_assets_localresources_table.bundle';
  assert.equal(bundleKind(scene), 'scene');
  assert.equal(patchesBundle('ja', scene), false);
  assert.equal(patchesBundle('zh', scene), true);
  assert.equal(patchesBundle('zh', tableUrl), false);
  assert.equal(patchesBundle('tw', tableUrl), true);
  assert.equal(patchesBundle('tw', BASE + 'defaultpackage_assets_localresources_font.bundle'), false);
  for (const other of [BASE + 'defaultpackage_assets_localresources_uiprefab.bundle',
    scene.replace('https:', 'http:'), scene.replace('crystal-test1', 'other'),
    'https://games.mofushippo.com/CryWebAws/Build/CryWebAws.data.unityweb']) assert.equal(patchesBundle('tw', other), false, other);
  assert.equal(siblingBundleUrl(scene, 'font'), BASE + 'defaultpackage_assets_localresources_font.bundle');
  assert.equal(originalUrl(patchUrl(scene)), scene);
  assert.equal(originalUrl(patchUrl(BASE + 'defaultpackage_assets_localresources_font.bundle')), null);
  assert.equal(originalUrl(patchUrl('https://example.com/defaultpackage_assets_localresources_scene.bundle')), null);
});
