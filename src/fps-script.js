// Runs only in the game frame's main world, not in the privileged Electron preload.
// A callback cap cannot change server-side game time.
function fpsScript(cap) {
  return `(() => {
    const targetCap = ${JSON.stringify(cap)};
    const key = '__cristeTimingPrototype';
    if (!window[key] && !targetCap) return;
    if (!window[key]) {
      const nativeRAF = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      let nextId = 1;
      const pending = new Map();
      let lastFrame = -Infinity;
      const timing = window[key] = {
        cap: 0, lastReal: null, callbacks: 0,
      };
      window.requestAnimationFrame = function (callback) {
        const id = nextId++;
        const tick = (timestamp) => {
          if (!pending.has(id)) return;
          const limit = timing.cap;
          // All callbacks scheduled for the same native frame must run together.
          if (limit && timestamp !== lastFrame && timestamp - lastFrame < 1000 / limit - 1) {
            pending.set(id, nativeRAF(tick));
            return;
          }
          pending.delete(id);
          lastFrame = timestamp;
          timing.lastReal = timestamp;
          timing.callbacks++;
          callback(timestamp);
        };
        pending.set(id, nativeRAF(tick));
        return id;
      };
      window.cancelAnimationFrame = function (id) {
        if (pending.has(id)) {
          nativeCancel(pending.get(id));
          pending.delete(id);
        } else {
          nativeCancel(id);
        }
      };
    }
    window[key].cap = targetCap;
  })();`;
}

module.exports = { fpsScript };
