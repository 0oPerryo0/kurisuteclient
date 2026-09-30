// Runs in the game's main world, not in the privileged Electron preload.
// Throttling animation callbacks is experimental and can affect game timing.
function fpsScript(cap) {
  return `(() => {
    const target = ${JSON.stringify(cap)};
    const key = '__cristeFpsPrototype';
    if (!window[key] && !target) return;
    if (!window[key]) {
      const nativeRAF = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      let nextId = 1;
      const pending = new Map();
      let lastFrame = -Infinity;
      window[key] = { cap: 0 };
      window.requestAnimationFrame = function (callback) {
        const id = nextId++;
        const tick = (timestamp) => {
          if (!pending.has(id)) return;
          const limit = window[key].cap;
          // All callbacks scheduled for the same native frame must run together.
          if (limit && timestamp !== lastFrame && timestamp - lastFrame < 1000 / limit - 1) {
            pending.set(id, nativeRAF(tick));
            return;
          }
          pending.delete(id);
          lastFrame = timestamp;
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
    window[key].cap = target;
  })();`;
}

module.exports = { fpsScript };
