function gameAssetListScript() {
  return `(() => [...new Set([
    ...performance.getEntriesByType('resource').map((entry) => entry.name),
    ...[...document.querySelectorAll('script[src]')].map((script) => script.src),
  ])].filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'games.mofushippo.com' &&
        /\\.(?:bundle|unityweb|wasm|data|bytes|br|gz|js)(?:$)/i.test(parsed.pathname);
    } catch { return false; }
  }).slice(0, 5000))()`;
}
module.exports = { gameAssetListScript };
