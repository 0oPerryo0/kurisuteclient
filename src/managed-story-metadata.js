// Reads a managed PE image already in memory. Never executes its code.
function inspectManagedStoryAssembly(heap, base, mode = 'story') {
  try {
    const max = Math.min(heap.length - base, 32 * 1024 * 1024);
    const check = (p, n) => {
      if (!Number.isInteger(p) || p < 0 || p + n > max) throw new Error('Outside PE image');
    };
    const u16 = (p) => { check(p, 2); return heap[base + p] | heap[base + p + 1] << 8; };
    const u32 = (p) => { check(p, 4); return (u16(p) | u16(p + 2) << 16) >>> 0; };
    const text = (p, limit = 100) => {
      check(p, 1);
      let value = '';
      for (let i = 0; i < limit; i++) {
        check(p + i, 1);
        const byte = heap[base + p + i];
        if (!byte) return value;
        if (byte < 32 || byte > 126) return null;
        value += String.fromCharCode(byte);
      }
      return null;
    };
    if (u16(0) !== 0x5a4d) return null;
    const pe = u32(60);
    if (pe > 4096 || u32(pe) !== 0x4550) return null;
    const count = u16(pe + 6);
    if (!count || count > 32) return null;
    const optional = pe + 24;
    const magic = u16(optional);
    if (![0x10b, 0x20b].includes(magic)) return null;
    const directory = optional + (magic === 0x10b ? 96 : 112);
    const sections = optional + u16(pe + 20);
    const rvaToOffset = (rva) => {
      for (let i = 0; i < count; i++) {
        const p = sections + i * 40;
        const virtualAddress = u32(p + 12);
        const rawSize = u32(p + 16);
        if (rva >= virtualAddress && rva - virtualAddress < rawSize)
          return u32(p + 20) + rva - virtualAddress;
      }
      throw new Error('RVA not in file-backed section');
    };
    const cli = rvaToOffset(u32(directory + 14 * 8));
    const root = rvaToOffset(u32(cli + 8));
    if (u32(root) !== 0x424a5342) return null;
    const versionLength = u32(root + 12);
    if (versionLength > 256) return null;
    let cursor = root + 16 + ((versionLength + 3) & ~3);
    const streamCount = u16(cursor + 2);
    cursor += 4;
    if (streamCount > 16) return null;
    const streams = {};
    for (let i = 0; i < streamCount; i++) {
      const offset = u32(cursor), size = u32(cursor + 4);
      const name = text(cursor + 8, 32);
      if (!name) return null;
      check(root + offset, size);
      streams[name] = { offset: root + offset, size };
      cursor += 8 + ((name.length + 1 + 3) & ~3);
    }
    const tables = streams['#~'] || streams['#-'];
    const strings = streams['#Strings'];
    const blobs = streams['#Blob'];
    if (!tables || !strings || !blobs) return null;
    const t = tables.offset;
    const heapSizes = heap[base + t + 6];
    const stringSize = heapSizes & 1 ? 4 : 2;
    const guidSize = heapSizes & 2 ? 4 : 2;
    const blobSize = heapSizes & 4 ? 4 : 2;
    const rows = Array(64).fill(0);
    cursor = t + 24;
    for (let i = 0; i < 64; i++) {
      if (u32(t + 8 + (i >= 32 ? 4 : 0)) & (1 << (i % 32))) {
        rows[i] = u32(cursor); cursor += 4;
        if (rows[i] > 1000000) return null;
      }
    }
    const indexSize = (table) => rows[table] < 65536 ? 2 : 4;
    const codedSize = (bits, ids) => Math.max(...ids.map((id) => rows[id])) < (1 << (16 - bits)) ? 2 : 4;
    const sizes = [
      2 + stringSize + 3 * guidSize,
      codedSize(2, [0, 26, 35, 1]) + 2 * stringSize,
      4 + 2 * stringSize + codedSize(2, [2, 1, 27]) + indexSize(4) + indexSize(6),
      indexSize(4), 2 + stringSize + blobSize, indexSize(6),
      8 + stringSize + blobSize + indexSize(8),
      indexSize(8), 4 + stringSize,
      indexSize(2) + codedSize(2, [2, 1, 27]),
      codedSize(3, [2, 1, 26, 6, 27]) + stringSize + blobSize,
      2 + codedSize(2, [4, 8, 23]) + blobSize,
    ];
    const starts = [];
    for (let i = 0; i <= 11; i++) { starts[i] = cursor; cursor += rows[i] * sizes[i]; }
    if (cursor > tables.offset + tables.size) return null;
    const index = (p, size) => size === 2 ? u16(p) : u32(p);
    const str = (p) => {
      const offset = index(p, stringSize);
      return offset < strings.size ? text(strings.offset + offset, Math.min(100, strings.size - offset)) : null;
    };
    const compressed = (state) => {
      check(state.p, 1);
      const a = heap[base + state.p++];
      if (!(a & 128)) return a;
      check(state.p, a & 64 ? 3 : 1);
      if (!(a & 64)) return (a & 63) << 8 | heap[base + state.p++];
      const result = (a & 31) * 16777216 + heap[base + state.p] * 65536 +
        heap[base + state.p + 1] * 256 + heap[base + state.p + 2];
      state.p += 3;
      return result;
    };
    const signature = (p) => {
      const offset = index(p, blobSize);
      if (offset >= blobs.size) return null;
      const state = { p: blobs.offset + offset };
      const length = compressed(state);
      if (!length || length > 100 || state.p + length > blobs.offset + blobs.size) return null;
      const end = state.p + length;
      const call = heap[base + state.p++];
      if (call & 16) compressed(state);
      const parameterCount = compressed(state);
      if (parameterCount > 16 || state.p >= end) return null;
      const primitive = { 1: 'void', 2: 'bool', 8: 'int', 12: 'float', 13: 'double', 14: 'string' };
      const returnType = primitive[heap[base + state.p++]] || 'complex';
      const parameterTypes = [];
      if (returnType !== 'complex') {
        for (let i = 0; i < parameterCount && state.p < end; i++) {
          const kind = primitive[heap[base + state.p++]] || 'complex';
          parameterTypes.push(kind);
          if (kind === 'complex') break;
        }
      }
      return { parameterCount, returnType, parameterTypes,
        fullyDecoded: parameterTypes.length === parameterCount && !parameterTypes.includes('complex') && state.p === end };
    };
    if (mode === 'player-protocol') {
      const constantNumbers = new Map();
      const parentSize = codedSize(2, [4, 8, 23]);
      for (let i = 0; i < rows[11]; i++) {
        const p = starts[11] + i * sizes[11];
        const parent = index(p + 2, parentSize);
        if ((parent & 3) !== 0 || heap[base + p] !== 8) continue;
        const blobIndex = index(p + 2 + parentSize, blobSize);
        if (!blobIndex || blobIndex >= blobs.size) continue;
        const state = { p: blobs.offset + blobIndex };
        if (compressed(state) !== 4 || state.p + 4 > blobs.offset + blobs.size) continue;
        const number = u32(state.p);
        if (number >= 1 && number <= 4096) constantNumbers.set(parent >>> 2, number);
      }
      const namedType = (coded) => {
        const row = coded >>> 2, table = [2, 1, 27][coded & 3];
        if (!row || ![1, 2].includes(table) || row > rows[table]) return null;
        const p = starts[table] + (row - 1) * sizes[table];
        const at = p + (table === 2 ? 4 : codedSize(2, [0, 26, 35, 1]));
        return { type: str(at), namespace: str(at + stringSize) };
      };
      const fieldSignature = (p) => {
        try {
          const blobIndex = index(p, blobSize);
          if (!blobIndex || blobIndex >= blobs.size) return null;
          const state = { p: blobs.offset + blobIndex };
          const length = compressed(state), end = state.p + length;
          if (length > 100 || end > blobs.offset + blobs.size || heap[base + state.p++] !== 6) return null;
          const parse = (depth = 0) => {
            if (depth > 4 || state.p >= end) return null;
            const kind = heap[base + state.p++];
            const primitive = { 2: 'bool', 8: 'int32', 9: 'uint32', 10: 'int64', 11: 'uint64',
              12: 'float', 13: 'double', 14: 'string', 5: 'uint8' };
            if (primitive[kind]) return { valueType: primitive[kind] };
            if ([17, 18].includes(kind)) return { valueType: 'message', messageType: namedType(compressed(state)) };
            if (kind === 29) return { valueType: 'array', element: parse(depth + 1) };
            if (kind === 21) {
              const generic = parse(depth + 1), count = compressed(state);
              if (count > 4) return null;
              const args = Array.from({ length: count }, () => parse(depth + 1));
              if (/^RepeatedField/.test(generic?.messageType?.type || '') && count === 1)
                return { valueType: 'repeated', element: args[0] };
            }
            return null;
          };
          return parse();
        } catch { return null; }
      };
      const protocolTypes = [];
      for (let i = 0; i < rows[2]; i++) {
        const p = starts[2] + i * sizes[2];
        const type = str(p + 4), namespace = str(p + 4 + stringSize);
        if (!type || /^Google[.]Protobuf/.test(namespace || '')) continue;
        const at = sizes[2] - indexSize(6) - indexSize(4);
        const first = index(p + at, indexSize(4));
        const next = i + 1 < rows[2] ? index(p + sizes[2] + at, indexSize(4)) : rows[4] + 1;
        if (!first || first > next || next > rows[4] + 1 || next - first > 8192) continue;
        const members = [];
        for (let row = first; row < next; row++) {
          const q = starts[4] + (row - 1) * sizes[4];
          members.push({ row, at: q, name: str(q + 2), flags: u16(q) });
        }
        const fields = [];
        for (const member of members) {
          if (!member.name?.endsWith('FieldNumber') || !(member.flags & 64)) continue;
          const number = constantNumbers.get(member.row);
          if (!number) continue;
          const name = member.name.slice(0, -11);
          const backing = members.find((item) => item.name?.replace(/^_+|_+$/g, '').toLowerCase() === name.toLowerCase());
          fields.push({ name, number, ...(backing ? fieldSignature(backing.at + 2 + stringSize) : {}) });
        }
        if (fields.length && protocolTypes.length < 1500) protocolTypes.push({ type, namespace, fields });
      }
      const observedTags = new Set([11, 15, 101, 1024, 1050, 1060, 1062]);
      const selected = new Map();
      const typeKey = (item) => (item.namespace || '') + '.' + item.type;
      const allTypes = new Map(protocolTypes.map((item) => [typeKey(item), item]));
      const select = (item) => {
        const key = typeKey(item);
        if (selected.has(key) || selected.size >= 250) return;
        selected.set(key, item);
        for (const field of item.fields) {
          const target = field.messageType || field.element?.messageType;
          if (target && allTypes.has(typeKey(target))) select(allTypes.get(typeKey(target)));
        }
      };
      for (const item of protocolTypes) if (item.fields.some((field) => observedTags.has(field.number) && field.number >= 100)) select(item);
      for (const item of protocolTypes) if (/player|userinfo|userbase|roleinfo|rolebase|login|profile/i.test(item.type) ||
          item.fields.some((field) => /nickname|playername|rolename|level|stamina|vitality|physicalpower|energy/i.test(field.name))) select(item);
      return protocolTypes.length ? { moduleName: rows[0] ? str(starts[0] + 2) : null,
        generatedTypeCount: protocolTypes.length, protocolTypes: [...selected.values()],
        selectionLimitReached: selected.size >= 250,
        note: 'Field numbers are read from managed metadata Constant rows, and types from field signatures. No runtime object values or methods are read or called. Matching message names still needs verification.' } : null;
    }
    const methodOwner = (row) => {
      for (let i = 0; i < rows[2]; i++) {
        const p = starts[2] + i * sizes[2];
        const first = index(p + sizes[2] - indexSize(6), indexSize(6));
        const next = i + 1 < rows[2]
          ? index(p + sizes[2] * 2 - indexSize(6), indexSize(6)) : rows[6] + 1;
        if (row >= first && row < next) return str(p + 4);
      }
      return null;
    };
    const resolveToken = (token) => {
      const table = token >>> 24, row = token & 0xffffff;
      if (!row || row > rows[table]) return null;
      if (table === 6) return { type: methodOwner(row), method: str(starts[6] + (row - 1) * sizes[6] + 8) };
      if (table === 4) return { field: str(starts[4] + (row - 1) * sizes[4] + 2) };
      if (table === 10) {
        const p = starts[10] + (row - 1) * sizes[10];
        const parentSize = codedSize(3, [2, 1, 26, 6, 27]);
        const parent = index(p, parentSize), parentRow = parent >>> 3;
        let type = null;
        if ((parent & 7) === 0 && parentRow && parentRow <= rows[2]) type = str(starts[2] + (parentRow - 1) * sizes[2] + 4);
        if ((parent & 7) === 1 && parentRow && parentRow <= rows[1])
          type = str(starts[1] + (parentRow - 1) * sizes[1] + codedSize(2, [0, 26, 35, 1]));
        return { type, member: str(p + parentSize) };
      }
      return { token: '0x' + token.toString(16) };
    };
    const bodyReferences = (method) => {
      const rva = u32(method);
      if (!rva) return null;
      let p = rvaToOffset(rva);
      const first = heap[base + p];
      let size;
      if ((first & 3) === 2) { size = first >>> 2; p++; }
      else if ((first & 3) === 3) {
        size = u32(p + 4); p += (u16(p) >>> 12) * 4;
      } else return null;
      if (size > 8192) return { error: 'Method exceeds inspection limit' };
      check(p, size);
      const end = p + size, instructions = [];
      const tokenOps = new Set([0x27, 0x28, 0x29, 0x6f, 0x70, 0x71, 0x73, 0x74, 0x75,
        0x79, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0x80, 0x81, 0x8c, 0x8d, 0x8f, 0xa3, 0xa4, 0xa5, 0xc2, 0xc6, 0xd0]);
      const labels = { 0x00: 'nop', 0x02: 'ldarg.0', 0x03: 'ldarg.1', 0x04: 'ldarg.2',
        0x14: 'ldnull', 0x16: 'ldc.i4.0', 0x17: 'ldc.i4.1', 0x25: 'dup', 0x26: 'pop',
        0x28: 'call', 0x2a: 'ret', 0x6f: 'callvirt', 0x73: 'newobj',
        0x7b: 'ldfld', 0x7c: 'ldflda', 0x7d: 'stfld', 0x7e: 'ldsfld', 0x80: 'stsfld' };
      const begin = p;
      while (p < end && instructions.length < 400) {
        const offset = p - begin, op = heap[base + p++];
        const item = { offset, opcode: labels[op] || '0x' + op.toString(16) };
        if (tokenOps.has(op)) { item.reference = resolveToken(u32(p)); p += 4; }
        else if (op === 0x72) { item.opcode = 'ldstr (value omitted)'; p += 4; }
        else if (op === 0xfe) {
          const second = heap[base + p++]; item.opcode = '0xfe' + second.toString(16).padStart(2, '0');
          if ([0x06, 0x07, 0x15, 0x16, 0x1c].includes(second)) { item.reference = resolveToken(u32(p)); p += 4; }
          else if ([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e].includes(second)) p += 2;
          else if ([0x12, 0x19].includes(second)) p++;
        } else if (op === 0x45) { const n = u32(p); if (n > 1000) return null; p += 4 + n * 4; }
        else if ((op >= 0x0e && op <= 0x13) || op === 0x1f || (op >= 0x2b && op <= 0x37) || op === 0xde) p++;
        else if (op === 0x20 || op === 0x22 || (op >= 0x38 && op <= 0x44) || op === 0xdd) p += 4;
        else if (op === 0x21 || op === 0x23) p += 8;
        if (p > end) return { error: 'Invalid IL operand bounds' };
        instructions.push(item);
      }
      return { instructions, truncated: p < end };
    };
    const results = [];
    const uiTypes = [];
    for (let i = 0; i < rows[2]; i++) {
      const p = starts[2] + i * sizes[2];
      const type = str(p + 4), namespace = str(p + 4 + stringSize);
      if (/^(?:Base)?UIPlotWin$|^UIBeginnerGuideWin$/.test(type || '')) {
        const fieldIndexOffset = sizes[2] - indexSize(6) - indexSize(4);
        const firstField = index(p + fieldIndexOffset, indexSize(4));
        const nextField = i + 1 < rows[2]
          ? index(p + sizes[2] + fieldIndexOffset, indexSize(4)) : rows[4] + 1;
        const fields = [];
        if (firstField && firstField <= nextField && nextField <= rows[4] + 1) {
          for (let j = firstField; j < nextField && fields.length < 160; j++) {
            const q = starts[4] + (j - 1) * sizes[4];
            const flags = u16(q);
            fields.push({ name: str(q + 2), static: !!(flags & 16) });
          }
        }
        uiTypes.push({ type, namespace, fields });
      }
      const firstMethod = index(p + sizes[2] - indexSize(6), indexSize(6));
      const nextMethod = i + 1 < rows[2]
        ? index(p + sizes[2] * 2 - indexSize(6), indexSize(6)) : rows[6] + 1;
      if (!firstMethod || firstMethod > nextMethod || nextMethod > rows[6] + 1) continue;
      for (let j = firstMethod; j < nextMethod; j++) {
        const method = starts[6] + (j - 1) * sizes[6];
        const name = str(method + 8);
        if (!/^(?:Base)?UIPlotWin$/.test(type || '') &&
            !/^SetPlotDialogPanelVisible$/.test(name || '')) continue;
        if (results.length >= 500) continue;
        const flags = u16(method + 6);
        const includeBody = /^(?:SetPlotDialogPanelVisible|BtnTrueFunctionClick|BtnCloseFunctionClick)$/.test(name || '') ||
          (type === 'UIPlotWin' && /^(?:Awake|OnOpen|OnInitData|Btn.*Click|.*(?:Dialog|Key|Pointer|Touch).*|BringOpenPlotOverlayToFront)$/.test(name || ''));
        results.push({ type, namespace, method: name, static: !!(flags & 16),
          public: (flags & 7) === 6, signature: signature(method + 8 + stringSize),
          ...(includeBody
            ? { body: bodyReferences(method) } : {}) });
      }
    }
    return results.length || uiTypes.length ? { methods: results, uiTypes,
      note: 'Metadata declarations only; not proof of a live GameObject or SendMessage compatibility.' } : null;
  } catch { return null; }
}

module.exports = { inspectManagedStoryAssembly };
