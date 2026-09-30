const { GameAssetCache } = require('./game-asset-cache');

function createGameAssetCache(gameSession, directory) {
  // Keep Chromium in charge of navigations, redirects, cookies and gameplay caching.
  // An HTTPS protocol handler also intercepts login pages and can break navigation.
  // Explicit prefetches use this same persistent session to warm its native disk cache.
  return new GameAssetCache(directory, (request, options) => gameSession.fetch(request, options));
}

module.exports = { createGameAssetCache };
