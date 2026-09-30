// Read-only scan of the loaded Unity heap. Returns addresses only, never calls a function.
function unityPointerProbeScript() {
  return `(() => {
    const module = window.unityInstance && window.unityInstance.Module || window.Module;
    const heap = module && module.HEAPU8;
    if (!heap) return { error: 'Unity heap is not visible' };
    const started = performance.now();
    const budget = 20000;
    let truncated = false;
    const timedOut = () => {
      if (performance.now() - started < budget) return false;
      truncated = true;
      return true;
    };
    const find = (term) => {
      const needle = [];
      for (let i = 0; i < term.length; i++) needle.push(term.charCodeAt(i));
      needle.push(0);
      const hits = [];
      const last = heap.length - needle.length;
      for (let i = 0; i <= last && hits.length < 8; i++) {
        if ((i & 0xfffff) === 0 && timedOut()) break;
        if (heap[i] !== needle[0]) continue;
        let matched = true;
        for (let j = 1; j < needle.length; j++) if (heap[i + j] !== needle[j]) { matched = false; break; }
        if (!matched) continue;
        hits.push(i);
        i += needle.length - 1;
      }
      return hits;
    };
    const hex = (value) => '0x' + (value >>> 0).toString(16);
    const words = heap.byteOffset % 4 === 0 && heap.length % 4 === 0
      ? new Uint32Array(heap.buffer, heap.byteOffset, heap.length >>> 2) : null;
    const terms = ['SetTimeScale', 'GetTimeScale', 'time.scale'];
    const strings = [];
    for (const term of terms) {
      const addresses = find(term);
      const references = [];
      if (words && addresses.length && !truncated) {
        for (let i = 0; i < words.length && references.length < 8; i++) {
          if ((i & 0xfffff) === 0 && timedOut()) break;
          const value = words[i];
          if (!addresses.includes(value)) continue;
          const before = [];
          for (let j = 4; j >= 1; j--) before.push(i >= j ? hex(words[i - j]) : null);
          references.push({ at: i * 4, target: value, before });
        }
      }
      strings.push({ term, addresses, references });
    }
    return {
      heapBytes: heap.length, bytesScanned: truncated ? null : heap.length,
      truncated, aligned: !!words, elapsedMs: Math.round(performance.now() - started), strings,
    };
  })()`;
}

module.exports = { unityPointerProbeScript };
