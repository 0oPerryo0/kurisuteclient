const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { storyRuntimeProbeScript } = require('../src/story-runtime-probe');

test('runtime probe finds structural candidates without writes or calls', async () => {
  const bytes = Buffer.alloc(4096);
  bytes.write('UIPlotWin\0', 2000);
  bytes.write('UI.Win\0', 2100);
  bytes.write('Img_TalkBg\0', 2200);
  bytes.write('BtnCloseFunctionClick\0', 2300);
  bytes.writeUInt32LE(2000, 136); bytes.writeUInt32LE(2100, 140);
  bytes.writeUInt32LE(2200, 1024); bytes.writeUInt32LE(128, 1032);
  bytes.writeUInt32LE(8, 1036); bytes.writeUInt32LE(0x04000001, 1040);
  bytes.writeUInt32LE(128, 512); bytes.writeUInt32LE(800, 520);
  bytes.writeUInt32LE(900, 800); bytes.writeUInt32LE(123456, 808);
  bytes.writeUInt32LE(2400, 908); bytes.writeUInt32LE(2450, 912);
  bytes.write('JImage\0', 2400); bytes.write('Jerry.UiFrame\0', 2450);
  bytes.writeUInt32LE(2300, 1612); bytes.writeUInt32LE(128, 1616);
  const before = Buffer.from(bytes);
  const report = await vm.runInNewContext(storyRuntimeProbeScript(), {
    window: { unityInstance: { Module: { HEAPU8: bytes } } },
    performance: { now: () => Date.now() }, setTimeout,
  });
  assert.ok(report.classCandidates.some((item) => item.address === 128));
  assert.equal(report.nameReferences.UIPlotWin[0].address, 136);
  assert.equal(report.fieldCandidates[0].name, 'Img_TalkBg');
  assert.equal(report.fieldCandidates[0].offset, 8);
  assert.equal(report.methodCandidates[0].address, 1600);
  assert.ok(report.objectCandidates.some((x) => x.address === 512));
  assert.equal(report.objectCandidates.find((x) => x.address === 512).plausibleUiLinkCount, 1);
  assert.deepEqual(bytes, before);
  assert.equal(report.passes.length, 4);
});

test('runtime probe handles unavailable Unity memory', async () => {
  const report = await vm.runInNewContext(storyRuntimeProbeScript(), { window: {} });
  assert.match(report.error, /not available/);
});

test('runtime probe accepts suffix-shared managed metadata names', async () => {
  const bytes = Buffer.alloc(4096);
  bytes.write('BaseUIPlotWin\0', 2000);
  bytes.write('UI.Win\0', 2100);
  bytes.writeUInt32LE(2004, 136); bytes.writeUInt32LE(2100, 140);
  const report = await vm.runInNewContext(storyRuntimeProbeScript(), {
    window: { unityInstance: { Module: { HEAPU8: bytes } } },
    performance: { now: () => Date.now() }, setTimeout,
  });
  assert.ok(report.names.UIPlotWin.includes(2004));
  assert.ok(report.classCandidates.some((item) => item.type === 'UIPlotWin' && item.address === 128));
});
