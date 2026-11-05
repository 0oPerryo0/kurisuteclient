// Where the game's YooAsset bundles are served from, and how their files are named.
// The OSS bucket names files after the bundle; the R18 CDN (since November 2026) names
// them after the file hash, so the bundle name must come from the package manifest.
const OSS_HOST = 'crystal-test1.oss-cn-beijing.aliyuncs.com';
const R18_RESOURCES = 'https://d1yl2keu90rg3.cloudfront.net/r18/resources/';
const PACKAGE = 'DefaultPackage';
const MAX_MANIFEST = 16 * 1024 * 1024;
const HASH_FILE = /^([0-9a-f]{32})\.bundle$/;

function bundleSource(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const cut = parsed.pathname.lastIndexOf('/') + 1;
    const base = parsed.origin + parsed.pathname.slice(0, cut), file = parsed.pathname.slice(cut);
    if (parsed.hostname === OSS_HOST) return { fileNames: 'bundle-name', base, file };
    const hashed = HASH_FILE.exec(file);
    if (base === R18_RESOURCES && hashed) return { fileNames: 'hash', base, file, hash: hashed[1] };
    return null;
  } catch { return null; }
}

// Bundle records hold a u16-length bundle name, a u32 Unity CRC, then a u16-length MD5 hex file hash.
// Only that exact shape is accepted; a name seen with two different hashes is dropped.
function manifestBundles(bytes) {
  const found = new Map(), conflicted = new Set();
  if (!bytes || bytes.length > MAX_MANIFEST) return found;
  const text = Buffer.from(bytes).toString('latin1');
  const pattern = /[a-z0-9_]{1,200}\.bundle/g;
  for (let match; (match = pattern.exec(text));) {
    const start = match.index, end = start + match[0].length;
    if (start < 2 || bytes.readUInt16LE(start - 2) !== match[0].length) continue;
    if (end + 6 + 32 > bytes.length || bytes.readUInt16LE(end + 4) !== 32) continue;
    const hash = text.slice(end + 6, end + 38);
    if (!/^[0-9a-f]{32}$/.test(hash)) continue;
    const name = match[0];
    if (found.has(name) && found.get(name) !== hash) conflicted.add(name);
    found.set(name, hash);
  }
  for (const name of conflicted) found.delete(name);
  return found;
}

// File hashes identify content, so learned entries never go stale and are kept across updates.
class BundleCatalog {
  constructor() { this.names = new Map(); this.hashes = new Map(); }
  add(bundles) {
    for (const [name, hash] of bundles) { this.names.set(hash, name); this.hashes.set(name, hash); }
  }
  nameOf(hash) { return this.names.get(hash) ?? null; }
  hashOf(name) { return this.hashes.get(name) ?? null; }
}

function versionUrl(base) { return base + PACKAGE + '.version'; }
function manifestUrl(base, version) {
  if (!/^[\w.-]{1,64}$/.test(version)) throw new Error('Unexpected package version');
  return base + PACKAGE + '_' + version + '.bytes';
}

module.exports = { OSS_HOST, R18_RESOURCES, MAX_MANIFEST, bundleSource, manifestBundles, BundleCatalog, versionUrl, manifestUrl };
