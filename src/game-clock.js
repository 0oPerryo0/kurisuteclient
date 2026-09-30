const SPEED_OPTIONS = [1, 2, 3, 5, 10];
const SPEEDS = [...SPEED_OPTIONS, 99];

function selectSpeed(value, menuEvent) {
  if (!SPEED_OPTIONS.includes(value)) throw new Error('Invalid speed');
  return value === 10 && menuEvent?.ctrlKey === true ? 99 : value;
}

function createClock(nativeNow, initialSpeed = 1) {
  const state = { speed: SPEEDS.includes(initialSpeed) ? initialSpeed : 1 };
  state.realBase = nativeNow();
  state.virtualBase = state.realBase;
  return {
    now() {
      return state.virtualBase + (nativeNow() - state.realBase) * state.speed;
    },
    setSpeed(value) {
      if (!SPEEDS.includes(value)) return false;
      state.virtualBase = this.now();
      state.realBase = nativeNow();
      state.speed = value;
      return true;
    },
  };
}

// Runs in the game page's main world before its scripts. It does not read cookies or URLs.
function gameClockScript(speed) {
  const initial = SPEEDS.includes(speed) ? speed : 1;
  return `(() => {
    if (location.hostname !== 'games.mofushippo.com' || window.__cristeClock) return;
    const native = performance.now.bind(performance);
    const state = { speed: ${initial}, realBase: native(), virtualBase: 0 };
    state.virtualBase = state.realBase;
    const now = () => state.virtualBase + (native() - state.realBase) * state.speed;
    try { performance.now = now; } catch {}
    try { Performance.prototype.now = now; } catch {}
    window.__cristeClock = {
      now, speed: () => state.speed,
      setSpeed(value) {
        if (!${JSON.stringify(SPEEDS)}.includes(value)) return false;
        state.virtualBase = now();
        state.realBase = native();
        state.speed = value;
        return true;
      },
    };
  })();`;
}

module.exports = { SPEED_OPTIONS, SPEEDS, selectSpeed, createClock, gameClockScript };
