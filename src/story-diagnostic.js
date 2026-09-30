// Read-only inspection: never calls Unity exports, SendMessage or game methods.
const { inspectManagedStoryAssembly } = require('./managed-story-metadata');
function storyDiagnosticScript() {
  return `(async () => {
    const names = (value) => {
      try { return value ? Object.getOwnPropertyNames(value) : []; } catch { return []; }
    };
    const wanted = /story|scenario|dialog|plot|messagewindow|textwindow|hideui|setvisible/i;
    const runtimeWanted = /hybridclr|hotupdate|assembly|il2cpp/i;
    const noise = /history|^_ST_|^System[.]|^Microsoft[.]|^UnityEngine[.]|^Dmm[.]/i;
    const instance = window.unityInstance;
    const module = instance?.Module || window.Module;
    const exports = module?.wasmExports || module?.asm || module?.instance?.exports;
    const canvases = [...document.querySelectorAll('canvas')].slice(0, 10).map((canvas) => ({
      width: canvas.width, height: canvas.height,
    }));
    const resources = [...new Set(performance.getEntriesByType('resource').map((entry) => {
      try {
        const name = new URL(entry.name).pathname.split('/').pop();
        return /^[\\w.-]{1,180}$/.test(name || '') &&
          /\\.(?:dll|bytes|bundle|wasm|data|json|unityweb|br|gz)$/i.test(name) ? name : null;
      } catch { return null; }
    }).filter(Boolean))].slice(0, 200);
    let heap = module?.HEAPU8;
    const candidates = new Set();
    const runtimeCandidates = new Set();
    const inspectAssembly = ${inspectManagedStoryAssembly.toString()};
    const managedStoryAssemblies = [];
    const heapBytes = heap?.length || 0;
    const limit = Math.min(heapBytes, 768 * 1024 * 1024);
    const chunkBytes = 4 * 1024 * 1024;
    let storyNamesTruncated = false;
    let heapChanged = false;
    let scanned = 0;
    if (heap) {
      let start = 0;
      for (let offset = 0; offset < limit; offset += chunkBytes) {
        const currentHeap = module?.HEAPU8;
        if (!currentHeap || currentHeap.length < limit) { heapChanged = true; break; }
        if (currentHeap !== heap) { heapChanged = true; heap = currentHeap; }
        const end = Math.min(limit, offset + chunkBytes);
        for (let i = offset; i < end; i++) {
          scanned = i + 1;
          const byte = heap[i];
          if (byte === 77 && heap[i + 1] === 90 && managedStoryAssemblies.length < 4) {
            const result = inspectAssembly(heap, i);
            if (result) managedStoryAssemblies.push(result);
          }
          if (byte >= 32 && byte <= 126) continue;
          const length = i - start;
          if (byte === 0 && length >= 5 && length <= 100) {
            let text = '';
            for (let j = start; j < i; j++) text += String.fromCharCode(heap[j]);
            // Identifier-like names only, not dialogue, URLs or arbitrary memory dumps.
            if (/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(text)) {
              if (wanted.test(text) && !noise.test(text)) {
                if (candidates.size < 500) candidates.add(text);
                else if (!candidates.has(text)) storyNamesTruncated = true;
              }
              if (runtimeWanted.test(text) && runtimeCandidates.size < 40) runtimeCandidates.add(text);
            }
          }
          start = i + 1;
        }
        // Yield between chunks so the game/browser can process input and paint.
        if (end < limit) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return {
      engine: 'Unity WebGL', unityReady: !!instance,
      sendMessageAvailable: typeof instance?.SendMessage === 'function',
      moduleAvailable: !!module, canvases, resourceFileNames: resources,
      globalCandidateNames: names(window).filter((name) => wanted.test(name)).slice(0, 80),
      moduleCandidateNames: names(module).filter((name) => wanted.test(name)).slice(0, 80),
      exportCount: names(exports).length,
      exportCandidateNames: names(exports).filter((name) => wanted.test(name)).slice(0, 100),
      diagnosticVersion: 5,
      managedStoryAssemblies,
      heapBytes, heapBytesScanned: scanned,
      heapScanPartial: heapBytes > scanned, heapChangedDuringScan: heapChanged,
      heapCandidateNames: [...candidates],
      runtimeCandidateNames: [...runtimeCandidates], storyNamesTruncated,
      note: 'Names are leads only, not proof of active story objects or callable methods. Hot-loaded assemblies may need separate inspection.',
    };
  })()`;
}

module.exports = { storyDiagnosticScript };
