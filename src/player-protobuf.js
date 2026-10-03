// Reviewed HotUpdate.dll declarations from the version-7 schema report:
// ProtobufMsg.InitGameDataSc = 101, InitGameDataSCMsg.{Level=2, Nickname=4, Energy=7}
// ProtobufMsg.UpdateEnergySC = 1022, UpdateEnergySCMsg.Energy = 1.
// StartGameLevelSC (3003), StartEventStageSC (3033), StartTowerStageSC (3053): Energy = 1.
// Only these response paths are candidates. Do not traverse roles, friends or balances.
function summarizePlayerProtobuf(bytes, onPlayer, includeNickname = false) {
  if (bytes.byteLength > 512 * 1024) return null;
  const scan = (start, end) => {
    let at = start;
    const fields = [];
    const smallVarint = () => {
      let value = 0;
      for (let i = 0; i < 5; i++) {
        if (at >= end) throw new Error('Truncated');
        const byte = bytes[at++];
        value += (byte & 127) * 2 ** (7 * i);
        if (!(byte & 128)) {
          if (value > 0xffffffff) throw new Error('Overflow');
          return value;
        }
      }
      throw new Error('Overflow');
    };
    while (at < end) {
      if (fields.length >= 8192) throw new Error('Field limit');
      const tag = smallVarint(), number = Math.floor(tag / 8), wireType = tag % 8;
      if (!number || number > 0x1fffffff) throw new Error('Invalid field');
      let start = at;
      if (wireType === 0) {
        for (let i = 0; ; i++) {
          if (at >= end || i >= 10) throw new Error('Invalid scalar');
          const byte = bytes[at++];
          if (i === 9 && byte > 1) throw new Error('Scalar overflow');
          if (!(byte & 128)) break;
        }
      } else if (wireType === 1) at += 8;
      else if (wireType === 5) at += 4;
      else if (wireType === 2) { const size = smallVarint(); start = at; at += size; }
      else throw new Error('Unsupported wire type');
      if (at > end) throw new Error('Truncated');
      // Offsets remain local; never include them or body slices in the returned report.
      fields.push({ number, wireType, start, end: at });
    }
    return fields;
  };
  const integer = (field) => {
    if (field.wireType !== 0 || field.end - field.start > 5) return null;
    let value = 0;
    for (let at = field.start; at < field.end; at++) value += (bytes[at] & 127) * 2 ** (7 * (at - field.start));
    return value <= 0x7fffffff ? value : null;
  };
  try {
    const envelope = scan(0, bytes.length);
    const ids = envelope.filter((field) => field.number === 1);
    if (ids.length !== 1 || ids[0].wireType !== 0) return null;
    // Never interpret login replies (including IDs/tokens), error replies, or mixed payloads.
    const codes = envelope.filter((field) => field.number === 5);
    if (codes.length > 1 || codes.some((field) => integer(field) !== 0)) return null;
    if (envelope.some((field) => [2, 3, 4].includes(field.number) && field.wireType !== 2)) return null;
    const payloads = envelope.filter((field) => field.number >= 10);
    if (payloads.length !== 1 || payloads[0].wireType !== 2) return null;
    const payload = payloads[0];
    const initial = payload.number === 101;
    const energyMessages = { 1022: 'UpdateEnergySC', 3003: 'StartGameLevelSC',
      3033: 'StartEventStageSC', 3053: 'StartTowerStageSC' };
    if (!initial && !energyMessages[payload.number]) return null;
    const message = initial ? 'InitGameDataSCMsg' : energyMessages[payload.number] + 'Msg';
    const path = initial ? '$.InitGameDataSc' : '$.' + energyMessages[payload.number];
    const wanted = initial ? [
      { number: 2, name: 'Level', category: 'level', type: 'int32' },
      { number: 4, name: 'Nickname', category: 'accountName', type: 'string' },
      { number: 7, name: 'Energy', category: 'stamina', type: 'int32' },
    ] : [{ number: 1, name: 'Energy', category: 'stamina', type: 'int32' }];
    const members = scan(payload.start, payload.end);
    const candidates = [];
    const player = { initial, envelopeField: payload.number };
    for (const target of wanted) {
      const matches = members.filter((field) => field.number === target.number);
      if (matches.length > 1 || matches.some((field) => field.wireType !== (target.type === 'string' ? 2 : 0))) return null;
      const candidate = { path: path + '.' + target.name, category: target.category,
        type: target.type, fieldNumber: target.number, present: matches.length === 1 };
      if (target.type === 'string' || !matches.length) candidate.valueOmitted = true;
      else {
        const value = integer(matches[0]);
        if (value === null) return null;
        candidate.sample = value;
        player[target.category === 'level' ? 'level' : 'stamina'] = value;
      }
      candidates.push(candidate);
    }
    // Only the opt-in live reader uses this callback. Diagnostics never receive a name.
    if (typeof onPlayer === 'function') {
      if (includeNickname && initial) {
        const name = members.find((field) => field.number === 4);
        if (name && name.end - name.start <= 256) {
          try {
            player.nickname = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(name.start, name.end))
              .replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 48);
          } catch { /* Invalid nickname text is not shared. */ }
        }
      }
      onPlayer(player);
    }
    return { format: 'protobuf-player-candidate', fields: candidates.map(({ path, type, fieldNumber, present }) =>
      ({ path, type, fieldNumber, present })), candidates,
      protobufPlayer: { message, envelopeField: payload.number, mappingVersion: 1,
        schemaSource: 'Reviewed HotUpdate.dll declarations in diagnostic version 7', verifiedAgainstGameDisplay: false },
      note: 'Only schema-mapped player level, nickname presence and energy. Nickname values, IDs, tokens and other fields are not decoded. Missing fields are not sampled or assumed zero. Compare numeric samples with the game display; Energy as stamina is not yet visually verified.' };
  } catch { return null; }
}

module.exports = { summarizePlayerProtobuf };
