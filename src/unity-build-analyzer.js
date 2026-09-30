// Runs within the authenticated game's sandboxed frame. Returns only a bounded
// summary of static build assets, never URLs, cookies, headers or asset files.
function unityBuildAnalyzerScript() {
  return `(async () => {
    const pattern = /\\.(?:wasm|data|framework|loader|js)(?:\\.unityweb|\\.br|\\.gz)?(?:$|[?#])/i;
    const terms = ['timescale', 'setgamespeed', 'setbattlespeed', 'settimescale',
      'speedmultiplier', 'battlemanager', 'gamemanager', 'speedcontroller',
      'global-metadata', 'unityengine.time'];
    const resourceNames = [
      ...performance.getEntriesByType('resource').map((entry) => entry.name),
      ...[...document.querySelectorAll('script[src]')].map((script) => script.src),
    ];
    const resources = [...new Set(resourceNames.filter((name) => {
        try { return new URL(name).protocol === 'https:' && pattern.test(name); }
        catch { return false; }
      }))];
    const priority = (name) => /metadata|\.framework|\.wasm/i.test(name) ? 0 : 1;
    resources.sort((a, b) => priority(a) - priority(b));
    const result = { engine: 'Unity WebGL', assetCount: resources.length, assets: [] };
    for (const url of resources.slice(0, 6)) {
      const item = { name: new URL(url).pathname.split('/').pop()?.slice(0, 100) || 'asset' };
      result.assets.push(item);
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok || !response.body) { item.error = 'Asset not fetchable'; continue; }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        const limit = 24 * 1024 * 1024;
        while (size < limit) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
        }
        if (size >= limit) { item.truncated = true; await reader.cancel(); }
        item.bytesScanned = size;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const content = new TextDecoder('latin1').decode(bytes);
        const lower = content.toLowerCase();
        item.hits = [];
        for (const term of terms) {
          let index = -1;
          let found = 0;
          while ((index = lower.indexOf(term, index + 1)) !== -1 && found++ < 8 && item.hits.length < 50) {
            const around = content.slice(Math.max(0, index - 35), index + term.length + 35)
              .replace(/[^\x20-\x7e]/g, ' ').trim();
            item.hits.push({ term, offset: index, around });
          }
        }
      } catch { item.error = 'Asset fetch or scan failed'; }
    }
    return result;
  })()`;
}

function unityBuildResourceListScript() {
  return `(() => {
    const pattern = /\\.(?:wasm|data|framework|loader|js)(?:\\.unityweb|\\.br|\\.gz)?(?:$|[?#])/i;
    const entries = [
      ...performance.getEntriesByType('resource').map((entry) => entry.name),
      ...[...document.querySelectorAll('script[src]')].map((script) => script.src),
    ];
    return [...new Set(entries.filter((url) => {
      try { return new URL(url).protocol === 'https:' && pattern.test(url); }
      catch { return false; }
    }))].sort((a, b) => Number(/metadata|\\.data/i.test(b)) - Number(/metadata|\\.data/i.test(a))).slice(0, 8);
  })()`;
}

module.exports = { unityBuildAnalyzerScript, unityBuildResourceListScript };
