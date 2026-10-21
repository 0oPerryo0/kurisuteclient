const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { inspectAsset, brotliPatched } = require('../src/asset-analysis');

test('finds names after Brotli decompression', async () => {
  const bytes = zlib.brotliCompressSync(Buffer.from('GameManager SetTimeScale speedMultiplier'));
  const result = await inspectAsset(bytes, 'game.data.unityweb', '24.22.1');
  assert.equal(result.format, 'brotli');
  assert.ok(result.hits.some((hit) => hit.term === 'settimescale'));
});

test('finds names after gzip decompression', async () => {
  const bytes = zlib.gzipSync(Buffer.from('BattleManager SetBattleSpeed'));
  const result = await inspectAsset(bytes, 'game.data.unityweb');
  assert.equal(result.format, 'gzip');
  assert.ok(result.hits.some((hit) => hit.term === 'battlemanager'));
});

test('skips Brotli decompression on runtimes without the CVE-2026-111497 fix', async () => {
  const bytes = zlib.brotliCompressSync(Buffer.from('GameManager SetTimeScale'));
  const result = await inspectAsset(bytes, 'game.data.unityweb', '24.21.0');
  assert.equal(result.format, 'brotli (disabled: unpatched runtime)');
  assert.equal(result.decodedBytes, bytes.length);
});

test('recognizes patched Node.js release lines', () => {
  for (const version of ['22.23.4', '24.22.1', '24.23.0', '26.12.1', '27.0.0']) assert.ok(brotliPatched(version), version);
  for (const version of ['20.19.0', '22.23.3', '24.21.0', '24.22.0', '25.9.0', '26.11.1']) assert.ok(!brotliPatched(version), version);
});
