const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { summarizePlayerWire, protobufLayout, isGameApiEndpoint } = require('../src/player-api-wire');

const json = JSON.stringify({ player: { nickname: 'PRIVATE_NAME', playerLevel: 42,
  stamina: 120, token: 'PRIVATE_TOKEN', playerId: 'PRIVATE_ID' } });

test('game wire routing accepts trailing slashes without trusting unrelated endpoints', () => {
  for (const url of ['https://games.mofushippo.com/game', 'https://games.mofushippo.com/game/',
    'https://games.mofushippo.com/game//?token=PRIVATE_TOKEN']) assert.equal(isGameApiEndpoint(url), true);
  for (const url of ['https://games.mofushippo.com/game/other', 'https://games.mofushippo.com/gamex',
    'https://games.mofushippo.com.evil.com/game/', 'http://games.mofushippo.com/game/']) assert.equal(isGameApiEndpoint(url), false);
});

test('wire inspector summarizes plain JSON, Base64 and compressed JSON without secrets', async () => {
  for (const bytes of [Buffer.from(json), Buffer.from(Buffer.from(json).toString('base64')),
    zlib.gzipSync(json), zlib.deflateSync(json), Buffer.from(zlib.gzipSync(json).toString('base64')),
    Buffer.from(JSON.stringify(Buffer.from(json).toString('base64url')))]) {
    const report = await summarizePlayerWire(bytes);
    assert.equal(report.format, 'json');
    assert.equal(report.candidates.find((field) => field.category === 'level').sample, 42);
    assert.equal(report.candidates.find((field) => field.category === 'stamina').sample, 120);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  }
});

test('protobuf layout inspection omits scalar values and message/string content', async () => {
  const bytes = Buffer.concat([Buffer.from([8, 42, 18, 12]), Buffer.from('PRIVATE_NAME')]);
  const report = await summarizePlayerWire(bytes);
  assert.equal(report.format, 'opaque-non-json');
  assert.deepEqual(report.wire.protobufCandidate.fields, [
    { number: 1, wireType: 0, byteLength: 1 }, { number: 2, wireType: 2, byteLength: 12 },
  ]);
  assert.equal(JSON.stringify(report).includes('PRIVATE_NAME'), false);
  assert.equal(JSON.stringify(report).includes('42'), false);
  assert.equal(protobufLayout(Buffer.from([0, 1, 2])), null);
  assert.equal(protobufLayout(Buffer.from([18, 99, 1])), null);
});

test('wire decoder bounds compressed output and never returns opaque body prefixes', async () => {
  const report = await summarizePlayerWire(zlib.gzipSync('x'.repeat(600000)));
  assert.equal(report.format, 'compression-unavailable-invalid-or-oversized');
  const opaque = await summarizePlayerWire(Buffer.from('PRIVATE_OPAQUE_BODY'));
  assert.equal(opaque.candidates.length, 0);
  assert.equal(JSON.stringify(opaque).includes('PRIVATE_OPAQUE_BODY'), false);
  assert.equal((await summarizePlayerWire(Buffer.alloc(600000))).format, 'oversized');
});
