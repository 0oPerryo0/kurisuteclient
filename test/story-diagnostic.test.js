const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { storyDiagnosticScript } = require('../src/story-diagnostic');

test('story diagnostic is read-only and reports bounded candidate names', async () => {
  const heap = Uint8Array.from(Buffer.from('StoryWindow\0SetVisible\0Dialogue text here\0https://host/Story?token=secret\0HotUpdate.dll\0'));
  const before = heap.slice();
  const fail = () => { throw new Error('Must not call game methods'); };
  const report = await vm.runInNewContext(storyDiagnosticScript(), {
    window: { unityInstance: { SendMessage: fail, Module: { HEAPU8: heap,
      wasmExports: { SetVisible: fail, other: fail } } } },
    document: { querySelectorAll: () => [{ width: 1136, height: 640 }] },
    performance: { getEntriesByType: () => [
      { name: 'https://host/build/HotUpdate.dll?token=secret' },
      { name: 'https://host/api?token=secret' },
    ] }, URL,
  });
  assert.equal(report.unityReady, true);
  assert.deepEqual(Array.from(report.heapCandidateNames), ['StoryWindow', 'SetVisible']);
  assert.deepEqual(Array.from(report.runtimeCandidateNames), ['HotUpdate.dll']);
  assert.deepEqual(Array.from(report.resourceFileNames), ['HotUpdate.dll']);
  assert.deepEqual(heap, before);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('story diagnostic handles Unity not yet loaded', async () => {
  const report = await vm.runInNewContext(storyDiagnosticScript(), {
    window: {}, document: { querySelectorAll: () => [] },
    performance: { getEntriesByType: () => [] }, URL,
  });
  assert.equal(report.unityReady, false);
  assert.equal(report.heapBytesScanned, 0);
});

test('story diagnostic scans past generic runtime names and chunk boundaries', async () => {
  const heap = new Uint8Array(4 * 1024 * 1024 + 200);
  heap.set(Buffer.from(Array.from({ length: 200 }, (_, i) => 'AssemblyName' + i).join('\0') + '\0'));
  heap.set(Buffer.from('StoryWindow\0PlotWindow\0History\0'), 4 * 1024 * 1024 - 5);
  const report = await vm.runInNewContext(storyDiagnosticScript(), {
    window: { unityInstance: { Module: { HEAPU8: heap } } },
    document: { querySelectorAll: () => [] },
    performance: { getEntriesByType: () => [] }, URL, setTimeout,
  });
  assert.deepEqual(Array.from(report.heapCandidateNames), ['StoryWindow', 'PlotWindow']);
  assert.equal(report.heapBytesScanned, heap.length);
  assert.equal(report.heapScanPartial, false);
  assert.equal(report.runtimeCandidateNames.length, 40);
});
