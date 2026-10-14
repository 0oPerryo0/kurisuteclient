const { readBundle, writeBundle, readTextAssets, replaceTextAssets } = require('./unity-bundle');

// value is GameConfig.LANGUAGE_TYPE in the game's HotUpdate.dll: 简体中文, 英语, 日语, 繁体中文.
// The game reads it once at startup; 繁体中文 shows the same Chinese column as 简体中文.
const LANGUAGES = {
  ja: { label: '日本語 (original)', value: 2 },
  zh: { label: '简体中文', value: 0 },
  tw: { label: '繁體中文（台灣，劇情保留原文）', value: 3, traditional: true },
};
const ORIGINAL_LANGUAGE = 'ja';
const PATCH_SCHEME = 'criste-game';
const BUNDLE_HOST = 'crystal-test1.oss-cn-beijing.aliyuncs.com';
const BUNDLES = {
  // The live GameConfig is in the YooAsset scene bundle; base-build scene copies are unused.
  scene: 'defaultpackage_assets_localresources_scene.bundle',
  table: 'defaultpackage_assets_localresources_table.bundle',
  font: 'defaultpackage_assets_localresources_font.bundle',
};
const SCENE_FILE = /^(?:level\d+|BuildPlayer-[^./]+)$/;
const MAX_CELL = 32767;

function bundleKind(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== BUNDLE_HOST || parsed.username || parsed.password) return null;
    const name = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
    return Object.keys(BUNDLES).find((kind) => BUNDLES[kind] === name) || null;
  } catch { return null; }
}

// Bundles the client rewrites for a language; Japanese loads everything unmodified.
function patchesBundle(language, url) {
  const kind = bundleKind(url), choice = LANGUAGES[language];
  if (!choice || language === ORIGINAL_LANGUAGE) return false;
  return kind === 'scene' || (kind === 'table' && !!choice.traditional);
}

function siblingBundleUrl(url, kind) {
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1) + BUNDLES[kind];
  parsed.search = '';
  return parsed.href;
}

function patchUrl(url) {
  return `${PATCH_SCHEME}://bundle/?u=${encodeURIComponent(url)}`;
}

function originalUrl(url) {
  try {
    const parsed = new URL(url);
    const target = parsed.protocol === PATCH_SCHEME + ':' && parsed.hostname === 'bundle' ? parsed.searchParams.get('u') : null;
    return target && ['scene', 'table'].includes(bundleKind(target)) ? target : null;
  } catch { return null; }
}

// serverType, resouceType, channelType (官方 = 10001), languageType, dmmPaymentType, dmmGameVariant, SSL.
function findGameConfigs(bytes) {
  const hits = [];
  for (let i = 8; i + 24 <= bytes.length; i += 4) {
    if (bytes.readUInt32LE(i) !== 10001) continue;
    const server = bytes.readUInt32LE(i - 8), resource = bytes.readUInt32LE(i - 4), language = bytes.readUInt32LE(i + 4);
    const payment = bytes.readUInt32LE(i + 8), variant = bytes.readUInt32LE(i + 12), ssl = bytes.readUInt32LE(i + 16);
    if (server <= 3 && resource <= 2 && language <= 3 && payment <= 1 && variant <= 1 && ssl <= 1) hits.push(i + 4);
  }
  return hits;
}

function patchSceneBundle(bytes, language) {
  const choice = LANGUAGES[language];
  if (!choice) throw new Error(`Unknown language ${language}`);
  const bundle = readBundle(bytes);
  let patched = 0;
  for (const node of bundle.nodes.filter((item) => SCENE_FILE.test(item.name))) {
    for (const hit of findGameConfigs(node.bytes)) { node.bytes.writeUInt32LE(choice.value, hit); patched++; }
  }
  if (!patched) throw new Error('GameConfig language setting not found in this game build');
  return { bytes: writeBundle(bundle), patched };
}

// Game tables: big-endian row and column counts, then cells as big-endian int16 length + UTF-8.
// Row 2 holds field names; rows 0, 1 and 3 are notes, labels and types.
function readTable(bytes) {
  const count = bytes.readUInt32BE(0), columns = bytes.readUInt32BE(4);
  const rows = [];
  let p = 8;
  while (p < bytes.length) {
    const row = [];
    for (let c = 0; c < columns; c++) {
      const length = bytes.readInt16BE(p);
      if (length < 0 || p + 2 + length > bytes.length) throw new Error('Corrupt game table');
      row.push(bytes.toString('utf8', p + 2, p + 2 + length));
      p += 2 + length;
    }
    rows.push(row);
  }
  return { count, columns, rows };
}

function writeTable({ count, columns, rows }) {
  const parts = [Buffer.alloc(8)];
  parts[0].writeUInt32BE(count, 0); parts[0].writeUInt32BE(columns, 4);
  for (const row of rows) {
    for (const cell of row) {
      const text = Buffer.from(cell, 'utf8');
      if (text.length > MAX_CELL) throw new Error('Game table cell too long');
      const length = Buffer.alloc(2);
      length.writeInt16BE(text.length, 0);
      parts.push(length, text);
    }
  }
  return Buffer.concat(parts);
}

// Language IDs of story dialogue: every table with a ScenarioText field is a story script.
function storyTextIds(assets) {
  const ids = new Set();
  for (const bytes of assets.values()) {
    let table;
    try { table = readTable(bytes); } catch { continue; }
    const fields = table.rows[2] || [];
    fields.forEach((field, column) => {
      if (field !== 'ScenarioText') return;
      for (const row of table.rows.slice(4)) for (const id of row[column].split(/[;,|]/)) if (id) ids.add(id);
    });
  }
  return ids;
}

const codepoint = (text) => [...text].length === 1 ? text.codePointAt(0) : -1;

// Taiwan Traditional text drawn with the game's font: characters the font lacks use their
// Japanese form (說→説) or, failing that, the Simplified form, so nothing renders blank.
function traditionalConverter({ toTaiwan, toJapanese, toSimplified }, coverage) {
  return (text) => {
    const converted = toTaiwan(text);
    if (!coverage) return converted;
    return Array.from(converted, (char) => {
      if (char.codePointAt(0) < 0x2e80 || coverage.has(char.codePointAt(0))) return char;
      return [toJapanese(char), toSimplified(char)].find((alt) => coverage.has(codepoint(alt))) || char;
    }).join('');
  };
}

// The font that already draws the most of the game's Chinese UI text is the one to fit.
function pickCoverage(fonts, sample) {
  const chars = [...new Set(sample)].filter((char) => char.codePointAt(0) >= 0x2e80);
  let best = null, bestCount = -1;
  for (const font of fonts) {
    const count = chars.filter((char) => font.has(char.codePointAt(0))).length;
    if (count > bestCount) { best = font; bestCount = count; }
  }
  return best;
}

// Converts non-story Language rows to Taiwan Traditional. The original text is kept in the
// otherwise unused IsCommon field so prefabs' built-in Simplified text still finds its row.
function convertLanguageTable(bytes, storyIds, makeConverter) {
  const table = readTable(bytes);
  const fields = table.rows[2] || [];
  const id = fields.indexOf('ID'), cn = fields.indexOf('CN'), common = fields.indexOf('IsCommon');
  if (id < 0 || cn < 0 || common < 0) throw new Error('Unexpected Language table layout');
  const rows = table.rows.slice(4).filter((row) => !storyIds.has(row[id]));
  const convert = makeConverter(rows.map((row) => row[cn]).join(''));
  let converted = 0;
  for (const row of rows) {
    const text = convert(row[cn]);
    if (text === row[cn]) continue;
    if (!row[common]) row[common] = row[cn];
    row[cn] = text;
    converted++;
  }
  return { bytes: writeTable(table), converted };
}

function patchTableBundle(bytes, makeConverter) {
  const bundle = readBundle(bytes);
  let converted = -1;
  for (const node of bundle.nodes) {
    let assets;
    try { assets = readTextAssets(node.bytes); } catch { continue; }
    if (!assets.has('Language')) continue;
    const result = convertLanguageTable(assets.get('Language'), storyTextIds(assets), makeConverter);
    node.bytes = replaceTextAssets(node.bytes, new Map([['Language', result.bytes]])).bytes;
    converted = result.converted;
  }
  if (converted < 0) throw new Error('Language table not found in this game build');
  return { bytes: writeBundle(bundle), converted };
}

module.exports = {
  LANGUAGES, ORIGINAL_LANGUAGE, PATCH_SCHEME, bundleKind, patchesBundle, siblingBundleUrl, patchUrl, originalUrl,
  findGameConfigs, patchSceneBundle, readTable, writeTable, storyTextIds, traditionalConverter, pickCoverage,
  convertLanguageTable, patchTableBundle,
};
