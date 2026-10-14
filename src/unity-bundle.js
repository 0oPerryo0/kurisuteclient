// Minimal readers and writers for the Unity 2022 files this client modifies:
// UnityFS asset bundles, serialized files holding TextAssets, and embedded TrueType fonts.
const MAX_PREFIX = 1024;
const BLOCK_SIZE = 0x20000;
const TEXT_ASSET = 49;

function lz4Block(input, size) {
  const output = Buffer.allocUnsafe(size);
  let i = 0, o = 0;
  while (i < input.length) {
    const token = input[i++];
    let literal = token >> 4;
    if (literal === 15) { let b; do { b = input[i++]; literal += b; } while (b === 255); }
    if (o + literal > size || i + literal > input.length) throw new Error('Corrupt LZ4 block');
    input.copy(output, o, i, i + literal); i += literal; o += literal;
    if (i >= input.length) break;
    const offset = input[i] | (input[i + 1] << 8); i += 2;
    let match = token & 15;
    if (match === 15) { let b; do { b = input[i++]; match += b; } while (b === 255); }
    match += 4;
    if (!offset || offset > o || o + match > size) throw new Error('Corrupt LZ4 block');
    for (let k = 0; k < match; k++, o++) output[o] = output[o - offset];
  }
  if (o !== size) throw new Error('LZ4 size mismatch');
  return output;
}

function decompress(bytes, flags, size) {
  switch (flags & 0x3f) {
    case 0: return bytes;
    case 2: case 3: return lz4Block(bytes, size);
    default: throw new Error(`Unsupported bundle compression ${flags & 0x3f}`);
  }
}

function cString(bytes, offset) {
  const end = bytes.indexOf(0, offset);
  if (end < 0) throw new Error('Unterminated string');
  return { value: bytes.toString('latin1', offset, end), next: end + 1 };
}

const align = (value, to) => Math.ceil(value / to) * to;

// YooAsset may serve a bundle behind zero padding; it is kept as served.
function readBundle(bytes) {
  const file = Buffer.from(bytes);
  const start = file.subarray(0, MAX_PREFIX + 8).indexOf('UnityFS\0');
  if (start < 0 || file.subarray(0, start).some((byte) => byte !== 0)) throw new Error('Unrecognized asset bundle');
  const bundle = file.subarray(start);
  let p = 8;
  const version = bundle.readUInt32BE(p); p += 4;
  const revision = cString(bundle, cString(bundle, p).next);
  p = revision.next;
  const size = Number(bundle.readBigInt64BE(p)), compressedInfo = bundle.readUInt32BE(p + 8),
    uncompressedInfo = bundle.readUInt32BE(p + 12), flags = bundle.readUInt32BE(p + 16);
  p += 20;
  if (version >= 7) p = align(p, 16);
  let infoBytes;
  if (flags & 0x80) infoBytes = bundle.subarray(size - compressedInfo, size);
  else { infoBytes = bundle.subarray(p, p + compressedInfo); p += compressedInfo; }
  const info = decompress(infoBytes, flags, uncompressedInfo);
  if (flags & 0x200) p = align(p, 16);
  const parts = [];
  let q = 20;
  for (let n = 0, count = info.readInt32BE(16); n < count; n++, q += 10) {
    const usize = info.readUInt32BE(q), csize = info.readUInt32BE(q + 4);
    parts.push(decompress(bundle.subarray(p, p + csize), info.readUInt16BE(q + 8), usize));
    p += csize;
  }
  const data = Buffer.concat(parts);
  const nodes = [];
  for (let n = 0, count = info.readInt32BE(q), r = q + 4; n < count; n++) {
    const offset = Number(info.readBigInt64BE(r)), length = Number(info.readBigInt64BE(r + 8));
    const name = cString(info, r + 20);
    nodes.push({ name: name.value, flags: info.readUInt32BE(r + 16), bytes: Buffer.from(data.subarray(offset, offset + length)) });
    r = name.next;
  }
  return { prefix: file.subarray(0, start), header: bundle.subarray(0, revision.next), version, flags, hash: info.subarray(0, 16), nodes };
}

// Writes the bundle back uncompressed, which Unity loads without any extra settings.
function writeBundle({ prefix, header, version, flags, hash, nodes }) {
  const data = Buffer.concat(nodes.map((node) => node.bytes));
  const blocks = [];
  for (let offset = 0; offset < data.length || !blocks.length; offset += BLOCK_SIZE)
    blocks.push(Math.min(BLOCK_SIZE, data.length - offset));
  const nodeTable = [];
  let offset = 0;
  for (const node of nodes) {
    const entry = Buffer.alloc(20);
    entry.writeBigInt64BE(BigInt(offset), 0); entry.writeBigInt64BE(BigInt(node.bytes.length), 8);
    entry.writeUInt32BE(node.flags, 16);
    nodeTable.push(entry, Buffer.from(node.name + '\0', 'latin1'));
    offset += node.bytes.length;
  }
  const blockTable = Buffer.alloc(4 + blocks.length * 10);
  blockTable.writeInt32BE(blocks.length, 0);
  blocks.forEach((size, index) => {
    blockTable.writeUInt32BE(size, 4 + index * 10); blockTable.writeUInt32BE(size, 8 + index * 10);
  });
  const count = Buffer.alloc(4);
  count.writeInt32BE(nodes.length, 0);
  const info = Buffer.concat([hash, blockTable, count, ...nodeTable]);
  let headerLength = header.length + 20;
  if (version >= 7) headerLength = align(headerLength, 16);
  let dataStart = headerLength + info.length;
  if (flags & 0x200) dataStart = align(dataStart, 16);
  const output = Buffer.alloc(dataStart + data.length);
  header.copy(output, 0);
  output.writeBigInt64BE(BigInt(output.length), header.length);
  output.writeUInt32BE(info.length, header.length + 8);
  output.writeUInt32BE(info.length, header.length + 12);
  // Block info is stored uncompressed, right after the header.
  output.writeUInt32BE((flags & ~0xbf) | 0x40, header.length + 16);
  info.copy(output, headerLength);
  data.copy(output, dataStart);
  return Buffer.concat([prefix, output]);
}

// Serialized file (format 22+, little-endian metadata): locates every object's data.
function readSerialized(file) {
  const format = file.readUInt32BE(8);
  if (format < 22 || file[16] !== 0) throw new Error(`Unsupported serialized file format ${format}`);
  const dataOffset = Number(file.readBigInt64BE(32));
  let p = cString(file, 48).next;
  p += 4;
  const typeTree = file[p++] !== 0;
  const types = [];
  for (let n = 0, count = file.readInt32LE(p), r = p + 4; n < count; n++) {
    const classId = file.readInt32LE(r);
    r += 7 + (classId === 114 ? 16 : 0) + 16;
    if (typeTree) {
      r += 8 + file.readInt32LE(r) * 32 + file.readInt32LE(r + 4);
      r += 4 + file.readInt32LE(r) * 4;
    }
    types.push(classId);
    p = r;
  }
  const count = file.readInt32LE(p);
  p = align(p + 4, 4);
  const objects = [];
  for (let n = 0; n < count; n++, p += 24) {
    objects.push({ entry: p, start: Number(file.readBigInt64LE(p + 8)), size: file.readUInt32LE(p + 16),
      classId: types[file.readInt32LE(p + 20)] });
  }
  return { dataOffset, objects };
}

function textAssetParts(file, dataOffset, object) {
  const base = dataOffset + object.start;
  const nameLength = file.readInt32LE(base);
  const name = file.toString('utf8', base + 4, base + 4 + nameLength);
  const scriptAt = base + align(4 + nameLength, 4);
  const scriptLength = file.readInt32LE(scriptAt);
  return { name, head: file.subarray(base, scriptAt), script: file.subarray(scriptAt + 4, scriptAt + 4 + scriptLength) };
}

function readTextAssets(file) {
  const { dataOffset, objects } = readSerialized(file);
  return new Map(objects.filter((object) => object.classId === TEXT_ASSET)
    .map((object) => textAssetParts(file, dataOffset, object)).map(({ name, script }) => [name, script]));
}

// Replaces TextAsset contents by name and moves the following objects to keep 8-byte alignment.
function replaceTextAssets(file, replacements) {
  const { dataOffset, objects } = readSerialized(file);
  const ordered = [...objects].sort((a, b) => a.start - b.start);
  const bodies = [];
  let end = 0, changed = 0;
  for (const object of ordered) {
    if (object.start !== align(end, 8)) throw new Error('Unexpected serialized object layout');
    let body = file.subarray(dataOffset + object.start, dataOffset + object.start + object.size);
    if (object.classId === TEXT_ASSET) {
      const { name, head, script } = textAssetParts(file, dataOffset, object);
      if (head.length + 4 + align(script.length, 4) !== object.size) throw new Error(`Unexpected TextAsset ${name}`);
      const replacement = replacements.get(name);
      if (replacement) {
        const length = Buffer.alloc(4);
        length.writeInt32LE(replacement.length, 0);
        body = Buffer.concat([head, length, replacement, Buffer.alloc(align(replacement.length, 4) - replacement.length)]);
        changed++;
      }
    }
    bodies.push({ object, body });
    end = object.start + object.size;
  }
  if (dataOffset + end !== file.length) throw new Error('Unexpected serialized file size');
  const output = [Buffer.from(file.subarray(0, dataOffset))];
  let position = 0;
  for (const { object, body } of bodies) {
    const start = align(position, 8);
    output.push(Buffer.alloc(start - position), body);
    output[0].writeBigInt64LE(BigInt(start), object.entry + 8);
    output[0].writeUInt32LE(body.length, object.entry + 16);
    position = start + body.length;
  }
  output[0].writeBigInt64BE(BigInt(dataOffset + position), 24);
  return { bytes: Buffer.concat(output), changed };
}

// Character coverage of TrueType/OpenType fonts embedded anywhere in the given bytes.
function fontCoverage(bytes) {
  const fonts = [];
  for (let o = bytes.indexOf('\x00\x01\x00\x00', 0, 'latin1'); o >= 0; o = bytes.indexOf('\x00\x01\x00\x00', o + 1, 'latin1')) {
    try {
      const tables = new Map();
      const count = bytes.readUInt16BE(o + 4);
      if (count < 5 || count > 40) continue;
      for (let n = 0; n < count; n++) {
        const at = o + 12 + n * 16;
        tables.set(bytes.toString('latin1', at, at + 4), o + bytes.readUInt32BE(at + 8));
      }
      if (!['cmap', 'name', 'head', 'hhea'].every((tag) => tables.get(tag) < bytes.length)) continue;
      const codepoints = new Set();
      const cmap = tables.get('cmap');
      for (let n = 0, subtables = bytes.readUInt16BE(cmap + 2); n < subtables; n++) {
        const table = cmap + bytes.readUInt32BE(cmap + 8 + n * 8), format = bytes.readUInt16BE(table);
        if (format === 12) {
          for (let g = 0, groups = bytes.readUInt32BE(table + 12); g < groups; g++) {
            const first = bytes.readUInt32BE(table + 16 + g * 12), last = bytes.readUInt32BE(table + 20 + g * 12);
            if (last > 0x10ffff || last < first) throw new Error('Not a font');
            for (let c = first; c <= last; c++) codepoints.add(c);
          }
        } else if (format === 4) {
          const segments = bytes.readUInt16BE(table + 6) / 2;
          for (let s = 0; s < segments; s++) {
            const last = bytes.readUInt16BE(table + 14 + s * 2), first = bytes.readUInt16BE(table + 16 + segments * 2 + s * 2);
            if (first !== 0xffff) for (let c = first; c <= last; c++) codepoints.add(c);
          }
        }
      }
      if (codepoints.size) fonts.push(codepoints);
    } catch { /* Not a font header. */ }
  }
  return fonts;
}

module.exports = { lz4Block, readBundle, writeBundle, readSerialized, readTextAssets, replaceTextAssets, fontCoverage };
