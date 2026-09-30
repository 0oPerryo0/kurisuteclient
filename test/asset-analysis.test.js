const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { inspectAsset } = require('../src/asset-analysis');

test('finds names after Brotli decompression', async () => {
  const bytes = zlib.brotliCompressSync(Buffer.from('GameManager SetTimeScale speedMultiplier'));
  const result = await inspectAsset(bytes, 'game.data.unityweb');
  assert.equal(result.format, 'brotli');
  assert.ok(result.hits.some((hit) => hit.term === 'settimescale'));
});

test('finds names after gzip decompression', async () => {
  const bytes = zlib.gzipSync(Buffer.from('BattleManager SetBattleSpeed'));
  const result = await inspectAsset(bytes, 'game.data.unityweb');
  assert.equal(result.format, 'gzip');
  assert.ok(result.hits.some((hit) => hit.term === 'battlemanager'));
});
