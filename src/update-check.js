const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Releases of this client are published on GitHub; only this repository's assets are trusted.
const REPOSITORY = '0oPerryo0/kurisuteclient';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases/`;
const ASSET_URL = `https://github.com/${REPOSITORY}/releases/download/`;
const ASSET_NAME = /^CristeDesktop-\d+(?:\.\d+){1,3}\.exe$/;
const MAX_ASSET = 512 * 1024 * 1024;

function parseVersion(text) {
  const match = /^v?(\d+(?:\.\d+){0,3})$/i.exec(String(text || '').trim());
  return match ? match[1].split('.').map(Number) : null;
}

// Positive when a is newer than b; null when either is not a plain numeric version.
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

// Returns the newer release described by GitHub's latest-release response, or null.
function newerRelease(release, currentVersion) {
  if (!release || release.draft || release.prerelease || !(compareVersions(release.tag_name, currentVersion) > 0)) return null;
  const version = parseVersion(release.tag_name).join('.');
  const page = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASE_PAGE) ? release.html_url : RELEASE_PAGE;
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((item) => ASSET_NAME.test(item?.name || '') &&
    typeof item.browser_download_url === 'string' && item.browser_download_url.startsWith(ASSET_URL) &&
    Number.isSafeInteger(item.size) && item.size > 0 && item.size <= MAX_ASSET);
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest || '')?.[1]?.toLowerCase() || null;
  return { version, page, asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: digest } : null };
}

async function checkLatest(fetcher, currentVersion) {
  const response = await fetcher(LATEST_RELEASE_API, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return newerRelease(await response.json(), currentVersion);
}

// Downloads beside a temporary name and only exposes the exe once size and digest match.
async function downloadAsset(fetcher, asset, directory, onProgress = () => {}) {
  const target = path.join(directory, asset.name), temp = target + '.download';
  const response = await fetcher(asset.url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
  const hash = crypto.createHash('sha256');
  let received = 0;
  await fs.promises.mkdir(directory, { recursive: true });
  const file = await fs.promises.open(temp, 'w');
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > asset.size) throw new Error('Download is larger than the release asset');
      hash.update(chunk);
      await file.write(chunk);
      onProgress(received / asset.size);
    }
    await file.close();
    if (received !== asset.size) throw new Error('Download is incomplete');
    if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('Download does not match the release checksum');
    await fs.promises.rename(temp, target);
    return target;
  } catch (error) {
    await file.close().catch(() => {});
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { REPOSITORY, LATEST_RELEASE_API, compareVersions, newerRelease, checkLatest, downloadAsset };
