const { inspectManagedStoryAssembly } = require('./managed-story-metadata');

function playerProtocolSchemaScript() {
  return `(async () => {
    const module = window.unityInstance?.Module || window.Module;
    let heap = module?.HEAPU8;
    if (!heap) return { error: 'Unity heap is not visible in this frame' };
    const inspect = ${inspectManagedStoryAssembly.toString()};
    const started = Date.now(), initialBytes = heap.length;
    const limit = Math.min(initialBytes, 768 * 1024 * 1024);
    const assemblies = [], fingerprints = new Set();
    let scanned = 0, stoppedEarly = false;
    for (let offset = 0; offset < limit; offset += 4 * 1024 * 1024) {
      if (Date.now() - started > 20000) { stoppedEarly = true; break; }
      heap = module.HEAPU8;
      if (!heap || heap.length < limit) { stoppedEarly = true; break; }
      const end = Math.min(limit, offset + 4 * 1024 * 1024);
      for (let at = offset; at < end; at++) {
        if (heap[at] !== 77 || heap[at + 1] !== 90) continue;
        const report = inspect(heap, at, 'player-protocol');
        if (!report || !report.protocolTypes.length) continue;
        const fingerprint = JSON.stringify(report.protocolTypes.map((item) => [item.namespace, item.type]));
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint); assemblies.push(report);
        if (assemblies.length >= 6) break;
      }
      scanned = end;
      if (assemblies.length >= 6) { stoppedEarly = scanned < limit; break; }
      if (end < limit) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { schemaProbeVersion: 1, heapBytes: initialBytes, bytesScanned: scanned, stoppedEarly,
      elapsedMs: Date.now() - started, assemblies,
      note: 'Only static managed protobuf declarations are extracted. No credentials, player objects, raw payloads, Unity calls or memory writes.' };
  })()`;
}

module.exports = { playerProtocolSchemaScript };
