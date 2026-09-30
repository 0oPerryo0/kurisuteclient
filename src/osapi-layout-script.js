// Only applied to the DMM osapi game-host frame, never to the game's canvas.
function osapiLayoutScript(enabled) {
  return `(() => {
    const key = '__cristeOsapiLayout';
    if (!window[key]) {
      const saved = new Map();
      let activeFrame = null;
      const set = (element, property, value) => {
        if (!saved.has(element)) saved.set(element, element.getAttribute('style'));
        element.style.setProperty(property, value, 'important');
      };
      const restore = () => {
        for (const [element, style] of saved) {
          if (style === null) element.removeAttribute('style');
          else element.setAttribute('style', style);
        }
        saved.clear();
        activeFrame = null;
      };
      const update = () => {
        if (!window[key].enabled) { if (saved.size) restore(); return; }
        const frame = [...document.querySelectorAll('iframe')].find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width >= 480 && rect.height >= 320;
        });
        if (!frame || !document.body) return;
        if (frame !== activeFrame) {
          restore();
          activeFrame = frame;
        }
        set(document.documentElement, 'height', '100%');
        set(document.documentElement, 'background', '#fff');
        set(document.body, 'height', '100vh');
        set(document.body, 'min-height', '100vh');
        set(document.body, 'margin', '0');
        set(document.body, 'background', '#fff');
        for (let node = frame.parentElement; node && node !== document.body; node = node.parentElement) {
          set(node, 'overflow', 'visible');
          set(node, 'transform', 'none');
        }
        set(frame, 'position', 'fixed');
        set(frame, 'top', '50%');
        set(frame, 'left', '50%');
        set(frame, 'width', '1136px');
        set(frame, 'height', '640px');
        set(frame, 'transform-origin', 'center center');
        const scale = Math.min(innerWidth / 1136, innerHeight / 640);
        set(frame, 'transform', 'translate(-50%, -50%) scale(' + scale + ')');
        set(frame, 'margin', '0');
        set(frame, 'background', '#fff');
      };
      window[key] = { enabled: false, update };
      new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener('resize', update);
    }
    window[key].enabled = ${JSON.stringify(enabled)};
    window[key].update();
  })();`;
}

module.exports = { osapiLayoutScript };
