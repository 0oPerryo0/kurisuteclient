// Runs in the DMM play page's main world. Leave the page and its game frame in place:
// changing iframe src or moving it can invalidate its DMM launch/session context.
function gameOnlyScript(enabled) {
  return `(() => {
    const key = '__cristeGameOnly';
    if (!window[key]) {
      const previous = new Map();
      let scheduled = false;
      let stage = null;
      let backdrop = null;
      let colors = ['#20222a', '#20222a', '#20222a', '#20222a'];
      const remember = (element) => {
        if (!previous.has(element)) previous.set(element, element.getAttribute('style'));
      };
      const set = (element, name, value) => {
        remember(element);
        element.style.setProperty(name, value, 'important');
      };
      const restore = () => {
        backdrop?.remove();
        backdrop = null;
        for (const [element, style] of previous) {
          if (style === null) element.removeAttribute('style');
          else element.setAttribute('style', style);
        }
        previous.clear();
        stage = null;
      };
      const candidate = () => {
        const frames = [...document.querySelectorAll('iframe')].filter((frame) => {
          const rect = frame.getBoundingClientRect();
          const src = frame.getAttribute('src') || '';
          return rect.width >= 480 && rect.height >= 320 &&
            !/google|doubleclick|googletagmanager|recaptcha|twitter/i.test(src);
        });
        if (frames.length) return frames.sort((a, b) =>
          b.getBoundingClientRect().width * b.getBoundingClientRect().height -
          a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
        // Some games draw directly on the play page instead of in an iframe.
        const canvases = [...document.querySelectorAll('canvas')].filter((canvas) => {
          const rect = canvas.getBoundingClientRect();
          return rect.width >= 480 && rect.height >= 320;
        });
        const canvas = canvases.sort((a, b) =>
          b.getBoundingClientRect().width * b.getBoundingClientRect().height -
          a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
        return canvas?.parentElement || null;
      };
      const update = () => {
        scheduled = false;
        if (!document.body) return;
        if (!window[key].enabled) { if (previous.size) restore(); return; }
        const found = candidate();
        if (!found) { if (previous.size) restore(); return; }
        if (found === stage) return;
        const rect = found.getBoundingClientRect();
        const ratio = Math.min(2.5, Math.max(0.5, rect.width / rect.height));
        restore();
        stage = found;
        const path = [];
        for (let node = stage; node && node !== document.body; node = node.parentElement) path.push(node);
        if (!path.length || path[path.length - 1].parentElement !== document.body) return;
        for (const node of path) {
          for (const sibling of node.parentElement.children) {
            if (sibling !== node) set(sibling, 'visibility', 'hidden');
          }
          set(node, 'visibility', 'visible');
          if (node !== stage) {
            set(node, 'overflow', 'visible');
            set(node, 'transform', 'none');
            set(node, 'contain', 'none');
            set(node, 'position', 'relative');
            set(node, 'z-index', '2147483646');
            set(node, 'background', 'transparent');
          }
        }
        set(document.documentElement, 'overflow', 'hidden');
        set(document.body, 'overflow', 'hidden');
        set(document.documentElement, 'background', '#fff');
        set(document.body, 'background', 'transparent');
        set(stage, 'position', 'fixed');
        set(stage, 'inset', 'auto');
        set(stage, 'top', '50%');
        set(stage, 'left', '50%');
        // Fit the whole game at its native aspect ratio, without a size cap.
        const aspect = stage.tagName === 'IFRAME' ? 1136 / 640 : ratio;
        const width = 'min(100vw, calc(100vh * ' + aspect + '))';
        const height = 'min(100vh, calc(100vw / ' + aspect + '))';
        set(stage, 'width', width);
        set(stage, 'height', height);
        set(stage, 'transform', 'translate(-50%, -50%)');
        set(stage, 'margin', '0');
        set(stage, 'border', '0');
        set(stage, 'box-shadow', 'none');
        set(stage, 'mask-image', 'none');
        set(stage, 'z-index', '2147483647');
        backdrop = document.createElement('div');
        backdrop.setAttribute('aria-hidden', 'true');
        backdrop.style.cssText = 'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483645!important;';
        stage.parentElement.appendChild(backdrop);
        window[key].setColors(colors);
      };
      const schedule = () => {
        if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
      };
      window[key] = {
        enabled: false,
        update,
        getStageRect: () => {
          if (!window[key].enabled || !stage?.isConnected) return null;
          const rect = stage.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            viewportWidth: innerWidth, viewportHeight: innerHeight };
        },
        setColors: (next) => {
          if (!Array.isArray(next) || next.length !== 4 ||
              !next.every((color) => /^#[0-9a-f]{6}$/i.test(color))) return;
          colors = next;
          if (backdrop) backdrop.style.background =
            'conic-gradient(from 0deg at 50% 50%, ' +
            colors[0] + ' 0deg, ' + colors[1] + ' 90deg, ' +
            colors[2] + ' 180deg, ' + colors[3] + ' 270deg, ' +
            colors[0] + ' 360deg)';
        },
      };
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener('resize', schedule);
    }
    window[key].enabled = ${JSON.stringify(enabled)};
    window[key].update();
  })();`;
}

module.exports = { gameOnlyScript };
