const { summarizePlayerJson, playerApiHelpersScript, isGameUrl } = require('./player-api-diagnostic');
const { summarizePlayerProtobuf } = require('./player-protobuf');
const { playerResponseMeta } = require('./player-response-meta');
const MAX_BODY = 512 * 1024;

function isGameApiEndpoint(value) {
  if (!isGameUrl(value)) return false;
  try { return new URL(value).pathname.replace(/\/+$/, '') === '/game'; }
  catch { return false; }
}

// Wire-layout hypothesis only: never return scalar values or length-delimited contents.
function protobufLayout(bytes) {
  let at = 0;
  const fields = [];
  const varint = (maximum) => {
    let value = 0, shift = 0;
    for (let i = 0; i < maximum; i++) {
      if (at >= bytes.length) throw new Error('Truncated');
      const byte = bytes[at++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error('Invalid varint');
  };
  try {
    while (at < bytes.length && fields.length < 64) {
      const tag = varint(5), number = Math.floor(tag / 8), wireType = tag % 8;
      if (!number || number > 4096) return null;
      let size;
      if (wireType === 0) {
        const start = at;
        // Skip the value without converting it into a diagnostic number.
        for (let i = 0; ; i++) {
          if (at >= bytes.length || i >= 10) return null;
          if (!(bytes[at++] & 128)) break;
        }
        size = at - start;
      } else if (wireType === 1) { size = 8; at += size; }
      else if (wireType === 5) { size = 4; at += size; }
      else if (wireType === 2) { size = varint(5); at += size; }
      else return null;
      if (at > bytes.length) return null;
      fields.push({ number, wireType, byteLength: size });
    }
    return at === bytes.length && fields.length >= 2 ? { fields,
      note: 'Possible protobuf wire layout only; not proof of this codec. Field meanings and values are unknown.' } : null;
  } catch { return null; }
}

async function decompressWire(bytes, format) {
  if (typeof DecompressionStream !== 'function') throw new Error('Decoder unavailable');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error('Decoded size limit');
      chunks.push(value);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally { reader.cancel().catch(() => {}); }
}

async function summarizePlayerWire(bytes, onPlayer, includeNickname = false) {
  const wire = { byteLength: bytes.byteLength, decodingSteps: [] };
  const empty = (format) => ({ format, wire, fields: [], candidates: [] });
  if (bytes.byteLength > MAX_BODY) return empty('oversized');
  let current = bytes;
  for (let layer = 0; layer < 4; layer++) {
    const gzip = current[0] === 31 && current[1] === 139;
    const zlib = current.length >= 2 && (current[0] & 15) === 8 &&
      current[0] >>> 4 <= 7 && ((current[0] << 8) | current[1]) % 31 === 0;
    if (gzip || zlib) {
      const format = gzip ? 'gzip' : 'deflate';
      wire.decodingSteps.push(gzip ? 'gzip' : 'zlib');
      try { current = await decompressWire(current, format); }
      catch { return empty('compression-unavailable-invalid-or-oversized'); }
      continue;
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(current); } catch {}
    if (text !== undefined) {
      const summary = summarizePlayerJson(text);
      if (summary.format === 'json') {
        const value = JSON.parse(text);
        if (typeof value === 'string' && value.length >= 8 && /^[A-Za-z0-9+/_=-]+$/.test(value)) {
          text = value;
          wire.decodingSteps.push('json-string');
        } else {
          wire.decodedByteLength = current.byteLength;
          return { ...summary, wire };
        }
      }
      const compact = text.trim();
      if (compact.length >= 8 && compact.length % 4 !== 1 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
        try {
          const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
          const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
          wire.decodingSteps.push(/[-_]/.test(compact) ? 'base64url' : 'base64');
          current = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          continue;
        } catch {}
      }
      wire.characterFormat = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? 'ascii' : 'utf8';
    } else wire.characterFormat = 'binary';
    wire.decodedByteLength = current.byteLength;
    const player = summarizePlayerProtobuf(current, onPlayer, includeNickname);
    if (player) return { ...player, wire };
    const layout = protobufLayout(current);
    if (layout) wire.protobufCandidate = layout;
    const responseMeta = playerResponseMeta(current);
    if (responseMeta) wire.responseMeta = responseMeta;
    return empty('opaque-non-json');
  }
  wire.decodedByteLength = current.byteLength;
  const player = summarizePlayerProtobuf(current, onPlayer, includeNickname);
  if (player) return { ...player, wire };
  const layout = protobufLayout(current);
  if (layout) wire.protobufCandidate = layout;
  const responseMeta = playerResponseMeta(current);
  if (responseMeta) wire.responseMeta = responseMeta;
  return empty('decoding-layer-limit');
}

function playerApiWireHelpersScript() {
  return `${playerApiHelpersScript()} ${isGameApiEndpoint.toString()} ${summarizePlayerProtobuf.toString()} ${playerResponseMeta.toString()} ${protobufLayout.toString()} ${decompressWire.toString()} ${summarizePlayerWire.toString()}`;
}

module.exports = { summarizePlayerWire, protobufLayout, playerApiWireHelpersScript, isGameApiEndpoint };
