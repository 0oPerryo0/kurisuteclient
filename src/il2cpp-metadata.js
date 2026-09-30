// Parses only the UnityWebData directory and the IL2CPP metadata tables needed
// to identify speed-related declarations. No extracted asset is written to disk.
const SIGNATURE = 'UnityWebData1.0\0';
const HEADER_FIELDS = [
  'stringLiteral', 'stringLiteralData', 'string', 'events', 'properties',
  'methods', 'parameterDefaultValues', 'fieldDefaultValues',
  'fieldAndParameterDefaultValueData', 'fieldMarshaledSizes', 'parameters',
  'fields', 'genericParameters', 'genericParameterConstraints',
  'genericContainers', 'nestedTypes', 'interfaces', 'vtableMethods',
  'interfaceOffsets', 'typeDefinitions',
];

function extractMetadata(data) {
  if (data.subarray(0, SIGNATURE.length).toString('ascii') !== SIGNATURE)
    throw new Error('Not a UnityWebData1.0 archive');
  const headerEnd = data.readUInt32LE(SIGNATURE.length);
  if (headerEnd < SIGNATURE.length + 4 || headerEnd > data.length)
    throw new Error('Invalid UnityWebData directory');
  let cursor = SIGNATURE.length + 4;
  while (cursor < headerEnd) {
    if (cursor + 12 > headerEnd) throw new Error('Truncated UnityWebData entry');
    const offset = data.readUInt32LE(cursor);
    const size = data.readUInt32LE(cursor + 4);
    const nameLength = data.readUInt32LE(cursor + 8);
    cursor += 12;
    if (nameLength > 1024 || cursor + nameLength > headerEnd || offset < headerEnd ||
        offset > data.length || size > data.length - offset)
      throw new Error('Invalid UnityWebData entry bounds');
    const name = data.subarray(cursor, cursor + nameLength).toString('utf8');
    cursor += nameLength;
    if (name === 'Il2CppData/Metadata/global-metadata.dat')
      return data.subarray(offset, offset + size);
  }
  throw new Error('global-metadata.dat is not in the UnityWebData archive');
}

function parseMetadata(data) {
  if (data.length < 256 || data.readUInt32LE(0) !== 0xfab11baf)
    throw new Error('Invalid IL2CPP metadata magic');
  const version = data.readInt32LE(4);
  // Versions 27-31 use the compact method/type layouts described by IL2CPP.
  if (version < 27 || version > 31)
    throw new Error(`IL2CPP metadata version ${version} needs another parser layout`);
  const fields = [...HEADER_FIELDS, 'images', 'assemblies'];
  // Version 27+ has no rgctx header pair between typeDefinitions and images.
  const tables = {};
  fields.forEach((name, index) => {
    const pos = 8 + index * 8;
    if (pos + 8 > data.length) throw new Error('Truncated IL2CPP header');
    const offset = data.readUInt32LE(pos);
    const size = data.readUInt32LE(pos + 4);
    if (offset > data.length || size > data.length - offset)
      throw new Error(`Invalid IL2CPP ${name} table`);
    tables[name] = { offset, size };
  });
  const str = (index) => {
    const table = tables.string;
    if (index >= table.size) return null;
    const start = table.offset + index;
    const end = data.indexOf(0, start);
    if (end < 0 || end >= table.offset + table.size || end - start > 256) return null;
    return data.toString('utf8', start, end);
  };
  const methodSize = version >= 31 ? 36 : 32;
  const typeSize = version >= 27 ? 88 : 0;
  const imageSize = 40;
  const parameterSize = 12;
  for (const [table, size] of [['methods', methodSize], ['typeDefinitions', typeSize],
    ['images', imageSize], ['parameters', parameterSize]]) {
    if (tables[table].size % size) throw new Error(`Unexpected IL2CPP ${table} record size`);
  }
  const count = (table, size) => tables[table].size / size;
  const record = (table, size, index) => tables[table].offset + size * index;
  const types = [];
  for (let i = 0; i < count('typeDefinitions', typeSize); i++) {
    const p = record('typeDefinitions', typeSize, i);
    types.push({
      name: str(data.readUInt32LE(p)), namespace: str(data.readUInt32LE(p + 4)),
      methodStart: data.readInt32LE(p + 36), methodCount: data.readUInt16LE(p + 64),
    });
  }
  const images = [];
  for (let i = 0; i < count('images', imageSize); i++) {
    const p = record('images', imageSize, i);
    images.push({ name: str(data.readUInt32LE(p)), start: data.readInt32LE(p + 8),
      count: data.readUInt32LE(p + 12) });
  }
  const wanted = /timecommands|timescale|gamespeed|battlespeed|speedmanager/i;
  const declarations = [];
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    if (type.methodCount > 1000 || (type.methodCount && type.methodStart < 0) ||
        type.methodStart + type.methodCount > count('methods', methodSize))
      throw new Error('Invalid IL2CPP method range');
    const image = images.find((entry) => i >= entry.start && i < entry.start + entry.count);
    for (let j = 0; j < type.methodCount; j++) {
      const p = record('methods', methodSize, type.methodStart + j);
      const name = str(data.readUInt32LE(p));
      if (!wanted.test(type.name || '') && !wanted.test(name || '')) continue;
      const paramStart = data.readInt32LE(p + (version >= 31 ? 16 : 12));
      const flags = data.readUInt16LE(p + (version >= 31 ? 28 : 24));
      const paramCount = data.readUInt16LE(p + (version >= 31 ? 34 : 30));
      if (paramCount > 16 || paramStart < 0 ||
          paramStart + paramCount > count('parameters', parameterSize)) continue;
      const parameters = [];
      for (let k = 0; k < paramCount; k++) {
        const q = record('parameters', parameterSize, paramStart + k);
        parameters.push({ name: str(data.readUInt32LE(q)), typeIndex: data.readInt32LE(q + 8) });
      }
      declarations.push({ assembly: image?.name || null, namespace: type.namespace,
        type: type.name, method: name, static: !!(flags & 0x10),
        public: (flags & 7) === 6, returnTypeIndex: data.readInt32LE(p + 8), parameters });
      if (declarations.length >= 120) break;
    }
    if (declarations.length >= 120) break;
  }
  const literals = [];
  const literalTable = tables.stringLiteral;
  const literalData = tables.stringLiteralData;
  const literalPattern = /time\.scale|ingamedebugconsole|executecommand/i;
  if (literalTable && literalData && literalTable.size % 8 === 0) {
    for (let i = 0; i < literalTable.size / 8 && literals.length < 20; i++) {
      const p = literalTable.offset + i * 8;
      const length = data.readUInt32LE(p);
      const index = data.readInt32LE(p + 4);
      if (!length || length > 80 || index < 0 || index + length > literalData.size) continue;
      const text = data.toString('utf8', literalData.offset + index, literalData.offset + index + length);
      if (literalPattern.test(text)) literals.push(text);
    }
  }
  const setter = declarations.find((item) => item.type === 'TimeCommands' && item.method === 'SetTimeScale');
  const bridge = setter ? {
    type: `${setter.namespace ? setter.namespace + '.' : ''}${setter.type}`,
    method: setter.method,
    static: setter.static,
    sendMessage: setter.static ? false : null,
    parameter: setter.parameters[0]?.name || null,
    note: setter.static
      ? 'Static method. Unity SendMessage cannot call it; it is the IngameDebugConsole time.scale command.'
      : 'Instance method. SendMessage can reach it only if an active GameObject has this component.',
  } : null;
  return {
    version, typeCount: types.length, methodCount: count('methods', methodSize),
    bridge, literals, declarations,
  };
}

module.exports = { extractMetadata, parseMetadata };
