// Envelope tags reviewed in the captured HotUpdate.dll declarations. These are
// response signals only: never replay a stage, sweep, item-use or purchase request.
function playerResponseMeta(bytes) {
  if (!bytes || bytes.byteLength > 512 * 1024) return null;
  let at = 0, count = 0, ids = 0, payloads = 0, codes = 0, payload = 0, hasError = false;
  const read = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (at >= bytes.length) throw new Error('Truncated');
      const byte = bytes[at++]; value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) {
        if (value > 0xffffffff) throw new Error('Overflow');
        return value;
      }
    }
    throw new Error('Overflow');
  };
  try {
    while (at < bytes.length) {
      if (++count > 64) return null;
      const tag = read(), number = Math.floor(tag / 8), type = tag % 8;
      if (!number || number > 4096) return null;
      if (number === 1 && (type !== 0 || ++ids !== 1)) return null;
      if (number === 5 && (type !== 0 || ++codes !== 1)) return null;
      if (number >= 10) {
        if (type !== 2 || ++payloads !== 1) return null;
        payload = number;
      }
      if (type === 0) {
        let nonzero = false;
        for (let i = 0; ; i++) {
          if (at >= bytes.length || i >= 10) return null;
          const byte = bytes[at++];
          if (i === 9 && byte > 1) return null;
          nonzero ||= (byte & 127) !== 0;
          if (!(byte & 128)) break;
        }
        if (number === 5) hasError = nonzero;
      } else if (type === 2) { const size = read(); at += size; }
      else if (type === 1) at += 8;
      else if (type === 5) at += 4;
      else return null;
      if (at > bytes.length) return null;
    }
    if (ids !== 1) return null;
    const events = { 3005: 'stage completed', 3009: 'stage swept', 3035: 'event stage completed',
      3055: 'tower stage completed', 3007: 'stage exited', 3037: 'event stage exited',
      3057: 'tower stage exited', 1020: 'item used', 1068: 'energy replenished' };
    return { hasError, gameplay: !hasError && payloads === 1 ? events[payload] || null : null };
  } catch { return null; }
}

module.exports = { playerResponseMeta };
