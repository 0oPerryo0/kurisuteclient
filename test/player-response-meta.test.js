const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { playerResponseMeta } = require('../src/player-response-meta');
const { summarizePlayerWire } = require('../src/player-api-wire');
const { scalar, message } = require('./fixtures/player-protobuf.cjs');

test('only schema-identified successful gameplay responses trigger refreshes', () => {
  for (const tag of [3005, 3009, 3035, 3055, 3007, 3037, 3057, 1020, 1068]) {
    const bytes = Buffer.concat([scalar(1, tag), message(4, 'PRIVATE_TOKEN'), scalar(5, 0),
      message(tag, 'PRIVATE_GAMEPLAY_DATA')]);
    const before = Buffer.from(bytes), meta = playerResponseMeta(bytes);
    assert.equal(meta.hasError, false);
    assert.equal(typeof meta.gameplay, 'string');
    assert.equal(JSON.stringify(meta).includes('PRIVATE_'), false);
    assert.deepEqual(bytes, before);
    const error = playerResponseMeta(Buffer.concat([scalar(1, tag), scalar(5, 1), message(tag, '')]));
    assert.equal(error.hasError, true);
    assert.equal(error.gameplay, null);
  }
  for (const tag of [17, 101, 1024, 3003, 3033, 3053, 4005, 888])
    assert.equal(playerResponseMeta(Buffer.concat([scalar(1, tag), message(tag, '')])).gameplay, null);
});

test('malformed, mixed, duplicated and wrong-type envelopes cannot trigger refreshes', () => {
  for (const bytes of [message(3005, ''), Buffer.from([0]), Buffer.from([8, 128]),
    Buffer.concat([scalar(1, 3005), scalar(1, 3005), message(3005, '')]),
    Buffer.concat([message(1, ''), message(3005, '')]),
    Buffer.concat([scalar(1, 3005), scalar(3005, 1)]),
    Buffer.concat([scalar(1, 3005), message(3005, ''), message(3009, '')]),
    Buffer.concat([scalar(1, 3005), message(5, ''), message(3005, '')]),
    Buffer.concat([scalar(1, 3005), scalar(5, 0), scalar(5, 0), message(3005, '')]),
    Buffer.concat([scalar(1, 3005), message(3005, '')]).subarray(0, -1), Buffer.alloc(600000)])
    assert.equal(playerResponseMeta(bytes), null);
});

test('gameplay signals survive supported wire encodings without exposing bodies or credentials', async () => {
  const bytes = Buffer.concat([scalar(1, 3005), message(4, 'PRIVATE_TOKEN'), message(3005, 'PRIVATE_REWARD')]);
  for (const body of [bytes, Buffer.from(bytes.toString('base64')), zlib.gzipSync(bytes), zlib.deflateSync(bytes)]) {
    const summary = await summarizePlayerWire(body);
    assert.equal(summary.wire.responseMeta.gameplay, 'stage completed');
    assert.equal(summary.wire.responseMeta.hasError, false);
    assert.equal(JSON.stringify(summary).includes('PRIVATE_'), false);
  }
});
