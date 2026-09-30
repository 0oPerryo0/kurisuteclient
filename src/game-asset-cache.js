const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_FILE = 256 * 1024 * 1024;
const MAX_CACHE = 2 * 1024 * 1024 * 1024;

function isGameAsset(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'games.mofushippo.com' ||
        parsed.username || parsed.password || parsed.hash) return false;
    for (const key of parsed.searchParams.keys()) if (!/^(?:v|version|hash)$/i.test(key)) return false;
    return /\.(?:bundle|unityweb|wasm|data|bytes|br|gz)$/i.test(parsed.pathname) ||
      /\.(?:loader|framework)\.js$/i.test(parsed.pathname);
  } catch { return false; }
}

function cachePolicy(headers) {
  const control = headers.get('cache-control') || '';
  if (/\b(?:no-store|private)\b/i.test(control) || headers.has('set-cookie') ||
      (headers.get('vary') || '').split(',').some((x) => !['', 'accept-encoding'].includes(x.trim().toLowerCase()))) return null;
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(control);
  const age = Number(headers.get('age')) || 0;
  // Unversioned bundle names must not stay fresh longer than the origin permits.
  const seconds = /\bno-cache\b/i.test(control) ? 0 : Math.max(0, Math.min(300, Number(maxAge?.[1] || 0) - age));
  return { freshUntil: Date.now() + seconds * 1000 };
}

class GameAssetCache {
  constructor(directory, fetcher) {
    this.directory = directory;
    this.fetcher = fetcher;
    this.pending = new Set();
    this.writing = new Set();
    this.generation = 0;
    this.clearing = false;
  }
  files(url) {
    const key = crypto.createHash('sha256').update(url).digest('hex');
    return { body: path.join(this.directory, key + '.bin'), metadata: path.join(this.directory, key + '.json') };
  }
  async read(url) {
    const files = this.files(url);
    try {
      const metadata = JSON.parse(await fs.promises.readFile(files.metadata, 'utf8'));
      const stat = await fs.promises.stat(files.body);
      if (metadata.url !== url || stat.size !== metadata.size) return null;
      return { ...files, ...metadata };
    } catch { return null; }
  }
  response(entry) {
    return new Response(Readable.toWeb(fs.createReadStream(entry.body)), { status: 200, headers: entry.headers });
  }
  async prefetch(request, options = {}) {
    // Do not short-circuit to our separate copy: Chromium must see this fetch so
    // it can cache the resource for the game's normal, unintercepted requests.
    return this.fetch(request, options, true);
  }
  async fetch(request, options = {}, warmBrowserCache = false) {
    const input = typeof request === 'string' ? new Request(request) : request;
    if (this.clearing || input.method !== 'GET' || !isGameAsset(input.url) || input.headers.has('range') || input.headers.has('authorization'))
      return this.fetcher(input, options);
    const cached = warmBrowserCache ? null : await this.read(input.url);
    const force = /no-cache|no-store|max-age=0/i.test(input.headers.get('cache-control') || '') ||
      input.cache === 'reload' || input.cache === 'no-cache';
    if (input.cache === 'no-store') return this.fetcher(input, options);
    if (cached && cached.freshUntil > Date.now() && !force) return this.response(cached);
    const headers = new Headers(input.headers);
    if (cached) {
      if (cached.headers.etag) headers.set('if-none-match', cached.headers.etag);
      else if (cached.headers['last-modified']) headers.set('if-modified-since', cached.headers['last-modified']);
    }
    const response = await this.fetcher(new Request(input, { headers }), options);
    if (response.status === 304 && cached) {
      const combined = new Headers(cached.headers);
      response.headers.forEach((value, key) => combined.set(key, value));
      const policy = cachePolicy(combined);
      if (policy) {
        combined.delete('content-encoding'); combined.delete('transfer-encoding');
        combined.set('content-length', String(cached.size));
        cached.headers = Object.fromEntries(combined);
        cached.freshUntil = policy.freshUntil;
        const { body, metadata, ...data } = cached;
        await fs.promises.writeFile(metadata, JSON.stringify(data)).catch(() => {});
      } else {
        await fs.promises.rm(cached.metadata, { force: true }).catch(() => {});
      }
      return this.response(cached);
    }
    const policy = cachePolicy(response.headers);
    const type = response.headers.get('content-type') || '';
    if (response.status === 200 && response.body && policy &&
        (!response.url || isGameAsset(response.url)) && !/text\/html|application\/json/i.test(type) &&
        Number(response.headers.get('content-length') || 0) <= MAX_FILE && !this.writing.has(input.url)) {
      const generation = this.generation;
      this.writing.add(input.url);
      const task = this.store(input.url, response.clone(), policy, generation)
        .catch(() => {}).finally(() => { this.pending.delete(task); this.writing.delete(input.url); });
      this.pending.add(task);
    }
    return response;
  }
  async store(url, response, policy, generation) {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const files = this.files(url), temp = files.body + '.tmp';
    let size = 0;
    const input = Readable.fromWeb(response.body);
    input.on('data', (chunk) => { size += chunk.length; if (size > MAX_FILE) input.destroy(new Error('Asset too large')); });
    try {
      await pipeline(input, fs.createWriteStream(temp));
      if (generation !== this.generation) return;
      const headers = Object.fromEntries(response.headers);
      // Fetch has already decoded transport compression; do not decode it twice on a disk hit.
      delete headers['content-encoding']; delete headers['transfer-encoding'];
      headers['content-length'] = String(size);
      await fs.promises.rename(temp, files.body);
      await fs.promises.writeFile(files.metadata, JSON.stringify({ url, size, headers, ...policy }));
      await this.trim();
    } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
  }
  async trim() {
    const names = await fs.promises.readdir(this.directory);
    const entries = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.bin$/.test(name)).map(async (name) => {
      const file = path.join(this.directory, name);
      try { const stat = await fs.promises.stat(file); return { file, size: stat.size, time: stat.mtimeMs }; } catch { return null; }
    }));
    let total = entries.reduce((sum, entry) => sum + (entry?.size || 0), 0);
    for (const entry of entries.filter(Boolean).sort((a, b) => a.time - b.time)) {
      if (total <= MAX_CACHE) break;
      await fs.promises.rm(entry.file, { force: true }).catch(() => {});
      await fs.promises.rm(entry.file.replace(/\.bin$/, '.json'), { force: true }).catch(() => {});
      total -= entry.size;
    }
  }
  async clear() {
    this.clearing = true;
    this.generation++;
    try {
      await Promise.all([...this.pending]);
      const names = await fs.promises.readdir(this.directory).catch(() => []);
      for (const name of names) {
        if (/^[a-f0-9]{64}\.(?:bin|json|bin\.tmp)$/.test(name))
          await fs.promises.rm(path.join(this.directory, name), { force: true });
      }
    } finally { this.clearing = false; }
  }
}

function manifestAssets(bytes, manifestUrl) {
  if (bytes.length > 16 * 1024 * 1024 || !isGameAsset(manifestUrl)) return [];
  // YooAsset binary manifests commonly include printable bundle filenames.
  // Only extract static-file paths, never execute manifest content or guess numeric URLs.
  const text = Buffer.from(bytes).toString('latin1');
  const names = text.match(/[A-Za-z0-9_./-]{1,240}\.(?:bundle|unityweb|wasm|data)(?:\.(?:br|gz))?/g) || [];
  return [...new Set(names.map((name) => {
    try { const url = new URL(name, manifestUrl).href; return isGameAsset(url) ? url : null; } catch { return null; }
  }).filter(Boolean))].slice(0, 5000);
}

module.exports = { GameAssetCache, isGameAsset, cachePolicy, manifestAssets };
