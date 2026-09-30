// Structural candidates only. No writes, function calls, or story text collection.
function storyRuntimeProbeScript() {
  return `(async () => {
    const module = window.unityInstance?.Module || window.Module;
    let heap = module?.HEAPU8;
    if (!heap) return { error: 'Unity heap is not available' };
    const initialBytes = heap.length;
    const limit = Math.min(initialBytes, 768 * 1024 * 1024);
    const started = performance.now();
    const terms = ['UIPlotWin', 'BaseUIPlotWin', 'UIBeginnerGuideWin',
      'Img_TalkBg', 'Text_RoleName', 'Text_RoleNameDec', 'Img_PlotBg',
      'SetVisible', 'SetPlotDialogPanelVisible', 'BtnCloseFunctionClick'];
    const hits = Object.fromEntries(terms.map((term) => [term, []]));
    const classes = [], fields = [], methods = [], objects = [];
    const nameReferences = Object.fromEntries(terms.map((term) => [term, []]));
    const nameMap = new Map();
    let stopped = false, heapChanged = false;
    const passes = [];
    const word = (at) => {
      if (at < 0 || at + 4 > heap.length) return null;
      return (heap[at] | heap[at + 1] << 8 | heap[at + 2] << 16 | heap[at + 3] << 24) >>> 0;
    };
    const ascii = (at) => {
      if (!at || at + 100 >= heap.length) return null;
      let value = '';
      for (let i = 0; i < 100; i++) {
        const byte = heap[at + i];
        if (!byte) return value;
        if (byte < 32 || byte > 126) return null;
        value += String.fromCharCode(byte);
      }
      return null;
    };
    let words;
    const scan = async (name, step, visit) => {
      let scanned = 0;
      for (let offset = 0; offset < limit; offset += 4 * 1024 * 1024) {
        if (performance.now() - started > 120000) { stopped = true; break; }
        const current = module?.HEAPU8;
        if (!current || current.length < limit) { stopped = true; heapChanged = true; break; }
        if (current !== heap) { heapChanged = true; heap = current; }
        words = new Uint32Array(heap.buffer, heap.byteOffset, Math.floor(heap.length / 4));
        const end = Math.min(limit, offset + 4 * 1024 * 1024);
        for (let at = offset; at < end; at += step) visit(at, step === 4 ? words[at >>> 2] : heap[at]);
        scanned = end;
        if (end < limit) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      passes.push({ name, bytesScanned: scanned });
    };
    const needles = terms.map((term) => ({ term, codes: [...term].map((x) => x.charCodeAt(0)) }));
    await scan('exact names', 1, (at, byte) => {
      if (byte !== 85 && byte !== 66 && byte !== 73 && byte !== 84 && byte !== 83) return;
      for (const { term, codes } of needles) {
        if (byte !== codes[0] || hits[term].length >= 32 ||
            at + codes.length >= limit || heap[at + codes.length] !== 0) continue;
        // .NET #Strings may share suffixes: UIPlotWin can start inside BaseUIPlotWin.
        let match = true;
        for (let i = 1; i < codes.length; i++) if (heap[at + i] !== codes[i]) { match = false; break; }
        if (match) { hits[term].push(at); nameMap.set(at, term); }
      }
    });
    const addresses = [...nameMap.keys()];
    const minName = addresses.length ? Math.min(...addresses) : Infinity;
    const maxName = addresses.length ? Math.max(...addresses) : -1;
    if (!stopped) await scan('name references and class layouts', 4, (at, value) => {
      if (value < minName || value > maxName) return;
      const name = nameMap.get(value);
      if (!name) return;
      const refs = nameReferences[name];
      if (refs.length < 24) refs.push({ address: at, target: value,
        nearbyNameReferences: [-16, -12, -8, -4, 4, 8, 12, 16].map((offset) => ({
          offset, name: nameMap.get(word(at + offset)) || null,
        })).filter((item) => item.name) });
      if (name !== 'UIPlotWin' && name !== 'BaseUIPlotWin' && name !== 'UIBeginnerGuideWin') return;
      const namespace = ascii(word(at + 4));
      if (!['UI.Win', 'UI.Base'].includes(namespace)) return;
      for (const nameOffset of [4, 8, 12, 16, 20, 24]) {
        if (at < nameOffset || classes.length >= 96) continue;
        classes.push({ address: at - nameOffset, type: name, namespace, nameOffset,
          note: 'Possible class prefix offset; must be validated against object and field references.' });
      }
    });
    const classMap = new Map(classes.map((item) => [item.address, item]));
    if (!stopped) await scan('field and method candidates', 4, (at, value) => {
      if (value < minName || value > maxName) return;
      const name = nameMap.get(value);
      if (!name) return;
      if (/^(?:Img_|Text_)/.test(name) && fields.length < 120) {
        // Candidate FieldInfo32: name, type, parent, offset, metadata token.
        const owner = classMap.get(word(at + 8));
        const offset = word(at + 12), token = word(at + 16);
        if (owner && offset >= 8 && offset < 4096 && !(offset % 4) && token >>> 24 === 4)
          fields.push({ address: at, name, owner: owner.type, classAddress: owner.address, offset });
      }
      if (/^(?:SetVisible|SetPlotDialogPanelVisible|BtnCloseFunctionClick)$/.test(name) && methods.length < 80) {
        // Candidate MethodInfo32: method pointer, virtual pointer, invoker, name, class.
        const owner = classMap.get(word(at + 4));
        if (owner && at >= 12) methods.push({ address: at - 12, name,
          owner: owner.type, classAddress: owner.address,
          note: 'Layout hypothesis only; pointers are not called or interpreted as executable targets.' });
      }
    });
    const classAddresses = [...classMap.keys()];
    const minClass = classAddresses.length ? Math.min(...classAddresses) : Infinity;
    const maxClass = classAddresses.length ? Math.max(...classAddresses) : -1;
    const uiLink = (at, field) => {
      const target = word(at + field.offset);
      if (!target || target + 12 >= heap.length || target % 4) return { field: field.name, offset: field.offset, plausibleUiObject: false };
      const klass = word(target);
      const type = ascii(word(klass + 8));
      const namespace = ascii(word(klass + 12));
      const expected = /^(?:Img_)/.test(field.name) ? /^(?:JImage|Image|RawImage)$/ : /^(?:JText|Text|JTextTMP|TextMeshProUGUI)$/;
      const plausible = expected.test(type || '') && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(namespace || '');
      return { field: field.name, offset: field.offset, plausibleUiObject: plausible,
        ...(plausible ? { targetAddress: target, targetType: type, targetNamespace: namespace,
          nativeObjectPointerPresent: !!word(target + 8) } : {}) };
    };
    if (!stopped && classes.length) await scan('object candidates', 4, (at, value) => {
      if (value < minClass || value > maxClass) return;
      const owner = classMap.get(value);
      if (!owner || objects.length >= 120) return;
      // Candidate managed object header: klass pointer, null monitor.
      if (word(at + 4) !== 0) return;
      const links = fields.filter((field) => field.classAddress === owner.address ||
        (owner.type === 'UIPlotWin' && field.owner === 'BaseUIPlotWin'))
        .map((field) => uiLink(at, field));
      objects.push({ address: at, type: owner.type, classAddress: owner.address,
        plausibleUiLinkCount: links.filter((link) => link.plausibleUiObject).length,
        dialogueFieldLinks: links });
    });
    return { probeVersion: 3, heapBytes: initialBytes, scanLimitBytes: limit, passes,
      stoppedEarly: stopped, heapChangedDuringScan: heapChanged,
      elapsedMs: Math.round(performance.now() - started), names: hits, nameReferences,
      classCandidates: classes, fieldCandidates: fields, methodCandidates: methods, objectCandidates: objects,
      note: 'Read-only IL2CPP32 layout hypotheses. Matches can be metadata or stale allocations, not live story objects. No memory was written and no Unity method or export was called.' };
  })()`;
}

module.exports = { storyRuntimeProbeScript };
