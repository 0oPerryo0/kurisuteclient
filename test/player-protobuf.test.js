const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { summarizePlayerProtobuf } = require('../src/player-protobuf');
const { summarizePlayerWire } = require('../src/player-api-wire');
const { scalar, message, initialPlayerReply } = require('./fixtures/player-protobuf.cjs');

test('selective protobuf mapping reads only initial player level/energy and nickname presence', () => {
  const bytes = initialPlayerReply(), before = Buffer.from(bytes);
  const report = summarizePlayerProtobuf(bytes);
  assert.equal(report.format, 'protobuf-player-candidate');
  assert.equal(report.protobufPlayer.message, 'InitGameDataSCMsg');
  assert.equal(report.protobufPlayer.verifiedAgainstGameDisplay, false);
  assert.deepEqual(report.candidates.map(({ path }) => path), [
    '$.InitGameDataSc.Level', '$.InitGameDataSc.Nickname', '$.InitGameDataSc.Energy',
  ]);
  assert.deepEqual(report.candidates.filter((field) => field.sample !== undefined).map((field) => field.sample), [42, 120]);
  const name = report.candidates.find((field) => field.category === 'accountName');
  assert.equal(name.present, true);
  assert.equal(name.valueOmitted, true);
  assert.equal(name.sample, undefined);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(report).includes('987654321'), false);
  assert.deepEqual(bytes, before);
});

test('selective mapping accepts energy updates including explicit zero without filling absent fields', () => {
  for (const energy of [0, 120, 5000]) {
    const report = summarizePlayerProtobuf(Buffer.concat([scalar(1, 1022), message(1022, scalar(1, energy))]));
    assert.equal(report.protobufPlayer.message, 'UpdateEnergySCMsg');
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].sample, energy);
  }
  const absent = summarizePlayerProtobuf(Buffer.concat([scalar(1, 1022), message(1022, Buffer.alloc(0))]));
  assert.equal(absent.candidates[0].present, false);
  assert.equal(absent.candidates[0].sample, undefined);
});

test('stage starts supply current stamina directly, not rewards, player level or a guessed stamina cap', () => {
  for (const [tag, name] of [[3003, 'StartGameLevelSCMsg'], [3033, 'StartEventStageSCMsg'], [3053, 'StartTowerStageSCMsg']]) {
    let player;
    const report = summarizePlayerProtobuf(Buffer.concat([scalar(1, tag), scalar(5, 0),
      message(tag, Buffer.concat([scalar(1, 0), scalar(2, 999), message(4, 'PRIVATE_OTHER')]))]), value => { player = value; });
    assert.equal(report.protobufPlayer.message, name);
    assert.equal(player.stamina, 0);
    assert.equal(player.level, undefined);
    assert.equal(player.staminaMax, undefined);
    assert.equal(report.candidates.length, 1);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  }
});

test('login, friends, quests, role and error envelopes never produce player candidates', () => {
  const inner = Buffer.concat([scalar(2, 42), message(4, 'PRIVATE_NAME'), scalar(7, 120)]);
  for (const tag of [10, 11, 15, 1024, 1060, 4001, 4005])
    assert.equal(summarizePlayerProtobuf(Buffer.concat([scalar(1, tag), message(tag, inner)])), null);
  for (const bytes of [
    message(101, inner),
    Buffer.concat([scalar(1, 101), scalar(5, 1), message(101, inner)]),
    Buffer.concat([scalar(1, 101), message(101, inner), message(1022, scalar(1, 10))]),
    Buffer.concat([scalar(1, 101), scalar(1, 101), message(101, inner)]),
  ]) assert.equal(summarizePlayerProtobuf(bytes), null);
});

test('malformed, duplicated, wrong-type and invalid int32 values fail closed', () => {
  for (const inner of [scalar(2, -1), scalar(7, 2147483648), message(2, 'not-a-level'),
    scalar(4, 42), Buffer.concat([scalar(2, 42), scalar(2, 99)]), Buffer.from([16, 128]),
    Buffer.from([34, 99, 1]), Buffer.from([0]), Buffer.from([11])]) {
    assert.equal(summarizePlayerProtobuf(Buffer.concat([scalar(1, 101), message(101, inner)])), null);
  }
  const bytes = initialPlayerReply();
  assert.equal(summarizePlayerProtobuf(bytes.subarray(0, bytes.length - 1)), null);
  assert.equal(summarizePlayerProtobuf(Buffer.alloc(600000)), null);
  assert.equal(summarizePlayerProtobuf(Buffer.concat([scalar(1, 101), message(101, Buffer.alloc(18000, 8))])), null);
});

test('unknown varints and nested contents are skipped, not interpreted or recursively inspected', () => {
  const inner = Buffer.concat([scalar(2, 42), scalar(7, 120), scalar(200, -1),
    message(4, Buffer.from([255, 254])), message(50, 'not even a protobuf object')]);
  const report = summarizePlayerProtobuf(Buffer.concat([scalar(1, 101), message(101, inner)]));
  assert.deepEqual(report.candidates.filter((field) => field.sample !== undefined).map((field) => field.sample), [42, 120]);
  assert.equal(report.candidates.find((field) => field.category === 'accountName').valueOmitted, true);
});

test('wire decoder handles raw, base64, gzip and zlib player replies without exposing secrets', async () => {
  const bytes = initialPlayerReply();
  for (const body of [bytes, Buffer.from(bytes.toString('base64')), zlib.gzipSync(bytes), zlib.deflateSync(bytes)]) {
    const report = await summarizePlayerWire(body);
    assert.equal(report.format, 'protobuf-player-candidate');
    assert.equal(report.candidates.find((field) => field.category === 'level').sample, 42);
    assert.equal(report.candidates.find((field) => field.category === 'stamina').sample, 120);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  }
});
