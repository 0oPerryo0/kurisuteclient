const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { manifestBundles, bundleSource, BundleCatalog, R18_RESOURCES } = require('../src/yoo-manifest');

// Mirrors a YooAsset bundle record: u16 name length, name, u32 Unity CRC, u16 hash length, MD5 hex.
function record(name, hash) {
  const nameLength = Buffer.alloc(2); nameLength.writeUInt16LE(name.length);
  const hashLength = Buffer.alloc(2); hashLength.writeUInt16LE(hash.length);
  return Buffer.concat([nameLength, Buffer.from(name), Buffer.from([1, 2, 3, 4]), hashLength, Buffer.from(hash),
    Buffer.alloc(13)]);
}
const TABLE = 'defaultpackage_assets_localresources_table.bundle';
const TABLE_HASH = '337fbbad8f3d334a26751cb7af58f5ea';
const FONT = 'defaultpackage_assets_localresources_font.bundle';
const FONT_HASH = '6ffb33238a4ee4fa5e85fff93468dd67';

test('reads bundle names and file hashes from a YooAsset manifest', () => {
  const bytes = Buffer.concat([Buffer.from('OOY\0header'), record(TABLE, TABLE_HASH), record(FONT, FONT_HASH)]);
  assert.deepEqual([...manifestBundles(bytes)], [[TABLE, TABLE_HASH], [FONT, FONT_HASH]]);
});

test('ignores names without a matching length prefix or hash', () => {
  const broken = record(TABLE, TABLE_HASH); broken.writeUInt16LE(TABLE.length + 1, 0);
  const shortHash = record(FONT, 'abc');
  assert.equal(manifestBundles(Buffer.concat([broken, shortHash])).size, 0);
  assert.equal(manifestBundles(Buffer.alloc(0)).size, 0);
});

test('a bundle name with conflicting hashes is dropped rather than guessed', () => {
  const bytes = Buffer.concat([record(TABLE, TABLE_HASH), record(TABLE, FONT_HASH)]);
  assert.equal(manifestBundles(bytes).has(TABLE), false);
});

test('identifies the OSS bucket by bundle name and the R18 CDN by file hash', () => {
  assert.deepEqual(bundleSource('https://crystal-test1.oss-cn-beijing.aliyuncs.com/resouce-dev-aws/' + TABLE + '?t=1'),
    { fileNames: 'bundle-name', base: 'https://crystal-test1.oss-cn-beijing.aliyuncs.com/resouce-dev-aws/', file: TABLE });
  assert.deepEqual(bundleSource(R18_RESOURCES + TABLE_HASH + '.bundle'),
    { fileNames: 'hash', base: R18_RESOURCES, file: TABLE_HASH + '.bundle', hash: TABLE_HASH });
  for (const url of [R18_RESOURCES + TABLE, R18_RESOURCES + 'DefaultPackage.version',
    'https://d1yl2keu90rg3.cloudfront.net/r18/webgl/' + TABLE_HASH + '.bundle',
    R18_RESOURCES.replace('https:', 'http:') + TABLE_HASH + '.bundle',
    'https://evil.cloudfront.net/r18/resources/' + TABLE_HASH + '.bundle',
    'https://user:pass@d1yl2keu90rg3.cloudfront.net/r18/resources/' + TABLE_HASH + '.bundle', 'not a url'])
    assert.equal(bundleSource(url), null, url);
});

test('catalog keeps every hash it has learned and looks up both directions', () => {
  const catalog = new BundleCatalog();
  catalog.add(new Map([[TABLE, TABLE_HASH]]));
  catalog.add(new Map([[FONT, FONT_HASH]]));
  assert.equal(catalog.nameOf(TABLE_HASH), TABLE);
  assert.equal(catalog.hashOf(FONT), FONT_HASH);
  assert.equal(catalog.nameOf('0'.repeat(32)), null);
  assert.equal(catalog.hashOf('missing.bundle'), null);
});

// Optional check against a real R18 manifest saved locally; skipped when absent.
const sample = process.env.CRISTE_R18_MANIFEST;
test('real R18 manifest maps the language bundles', { skip: !sample || !fs.existsSync(sample || '') }, () => {
  const bundles = manifestBundles(fs.readFileSync(path.resolve(sample)));
  assert.match(bundles.get(TABLE), /^[0-9a-f]{32}$/);
  assert.match(bundles.get(FONT), /^[0-9a-f]{32}$/);
  assert.match(bundles.get('defaultpackage_assets_localresources_scene.bundle'), /^[0-9a-f]{32}$/);
});
