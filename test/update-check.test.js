const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LATEST_RELEASE_API, compareVersions, newerRelease, checkLatest, downloadAsset } = require('../src/update-check');

const DOWNLOAD = 'https://github.com/0oPerryo0/kurisuteclient/releases/download/';
const exe = Buffer.from('new portable exe');
const release = (overrides = {}) => ({
  tag_name: '0.0.7', draft: false, prerelease: false,
  html_url: 'https://github.com/0oPerryo0/kurisuteclient/releases/tag/0.0.7',
  assets: [{ name: 'CristeDesktop-0.0.7.exe', browser_download_url: DOWNLOAD + '0.0.7/CristeDesktop-0.0.7.exe', size: exe.length,
    digest: 'sha256:' + crypto.createHash('sha256').update(exe).digest('hex') }],
  ...overrides,
});
const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body,
  body: (async function* () { yield body.subarray(0, 3); yield body.subarray(3); })() });

test('compares dotted versions numerically, with or without a v prefix', () => {
  assert.equal(compareVersions('0.0.10', '0.0.9'), 1);
  assert.equal(compareVersions('v0.1', '0.0.99'), 1);
  assert.equal(compareVersions('0.0.6', '0.0.6.0'), 0);
  assert.equal(compareVersions('0.0.5', '0.0.6'), -1);
  assert.equal(compareVersions('0.04 beta', '0.0.6'), null);
});

test('offers only newer published releases with a trusted exe asset', () => {
  assert.deepEqual(newerRelease(release(), '0.0.6'), { version: '0.0.7', page: release().html_url,
    asset: { name: 'CristeDesktop-0.0.7.exe', url: release().assets[0].browser_download_url, size: exe.length,
      sha256: crypto.createHash('sha256').update(exe).digest('hex') } });
  assert.equal(newerRelease(release(), '0.0.7'), null);
  assert.equal(newerRelease(release({ prerelease: true }), '0.0.6'), null);
  assert.equal(newerRelease(release({ tag_name: 'latest' }), '0.0.6'), null);
  for (const asset of [{ ...release().assets[0], browser_download_url: 'https://evil.example/CristeDesktop-0.0.7.exe' },
    { ...release().assets[0], browser_download_url: 'https://github.com/someone/else/releases/download/0.0.7/CristeDesktop-0.0.7.exe' },
    { ...release().assets[0], name: 'setup.exe' }, { ...release().assets[0], size: 0 }]) {
    assert.equal(newerRelease(release({ assets: [asset] }), '0.0.6').asset, null, JSON.stringify(asset));
  }
  const offsite = newerRelease(release({ html_url: 'https://evil.example/' }), '0.0.6');
  assert.equal(offsite.page, 'https://github.com/0oPerryo0/kurisuteclient/releases/');
  assert.equal(newerRelease(release({ assets: [{ ...release().assets[0], digest: undefined }] }), '0.0.6').asset.sha256, null);
});

test('queries the latest-release API and treats a repository without releases as up to date', async () => {
  let requested;
  assert.equal((await checkLatest(async (url) => { requested = url; return respond(release()); }, '0.0.6')).version, '0.0.7');
  assert.equal(requested, LATEST_RELEASE_API);
  assert.equal(await checkLatest(async () => respond({}, 404), '0.0.6'), null);
  await assert.rejects(checkLatest(async () => respond({}, 403), '0.0.6'), /403/);
});

test('downloads only a complete, checksum-matching exe', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'criste-update-'));
  try {
    const asset = newerRelease(release(), '0.0.6').asset;
    const progress = [];
    const file = await downloadAsset(async () => respond(exe), asset, directory, (value) => progress.push(value));
    assert.equal(file, path.join(directory, 'CristeDesktop-0.0.7.exe'));
    assert.deepEqual(fs.readFileSync(file), exe);
    assert.equal(progress.at(-1), 1);
    fs.rmSync(file);
    const tampered = Buffer.from(exe).fill(0x41, 0, 1);
    await assert.rejects(downloadAsset(async () => respond(tampered), asset, directory), /checksum/);
    await assert.rejects(downloadAsset(async () => respond(exe.subarray(1)), asset, directory), /incomplete/);
    await assert.rejects(downloadAsset(async () => respond(Buffer.concat([exe, exe])), asset, directory), /larger/);
    await assert.rejects(downloadAsset(async () => respond(exe, 404), asset, directory), /404/);
    assert.deepEqual(fs.readdirSync(directory), [], 'failed downloads leave nothing behind');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
