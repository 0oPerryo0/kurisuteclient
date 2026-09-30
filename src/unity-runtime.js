// Runs inside the loaded game frame. Returns names only, never values, URLs or cookies.
function unityRuntimeInspectorScript() {
  return `(() => {
    const namesOf = (value) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return [];
      try { return Object.getOwnPropertyNames(value); } catch { return []; }
    };
    const instance = window.unityInstance;
    const module = instance && instance.Module || window.Module;
    const exportsObject = module && (module.wasmExports || module.asm ||
      (module.instance && module.instance.exports));
    const keys = namesOf(exportsObject);
    const wanted = /time|scale|il2cpp|console|debuglog/i;
    const floatCall = /^(?:_|)?dynCall_(?:vf|vif|if|fi)$/;
    return {
      unityInstance: typeof instance,
      sendMessage: typeof (instance && instance.SendMessage),
      module: typeof module,
      exportCount: keys.length,
      sendMessageExports: keys.filter((key) => /sendmessage/i.test(key)).slice(0, 10),
      speedExports: keys.filter((key) => wanted.test(key) && !/^_?dynCall_/i.test(key)).slice(0, 40),
      floatCallExports: keys.filter((key) => floatCall.test(key)),
    };
  })()`;
}

module.exports = { unityRuntimeInspectorScript };
