// Guesses are deliberately narrow. Probes send 1× only and never change settings.
const OBJECTS = ['GameManager', 'GameController', 'SystemManager', 'BattleManager', 'Main', 'GameRoot'];
const METHODS = ['SetTimeScale', 'SetGameSpeed', 'SetSpeed', 'SetBattleSpeed'];

function guessScript(object, method) {
  if (!OBJECTS.includes(object) || !METHODS.includes(method)) throw new Error('Unknown Unity guess');
  return `(() => {
    const instance = window.unityInstance;
    if (typeof instance?.SendMessage !== 'function') return false;
    // A speed of 1 is an idempotent probe for common setter-style methods.
    instance.SendMessage(${JSON.stringify(object)}, ${JSON.stringify(method)}, 1);
    return true;
  })()`;
}

module.exports = { guessScript, OBJECTS, METHODS };
