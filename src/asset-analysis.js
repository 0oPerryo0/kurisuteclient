const { Readable } = require('node:stream');
const zlib = require('node:zlib');

const MAX_DECODED = 96 * 1024 * 1024;
const TERMS = [
  'timescale', 'setgamespeed', 'setbattlespeed', 'settimescale',
  'speedmultiplier', 'battlemanager', 'gamemanager', 'speedcontroller',
  'global-metadata', 'unityengine.time',
];

async function decodedBytes(bytes, name) {
  if (bytes[0] === 0x00 && bytes.subarray(1, 4).toString('ascii') === 'asm')
    return { bytes, format: 'wasm', truncated: false };
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzip && !/\.unityweb$|\.br$/i.test(name))
    return { bytes, format: 'uncompressed or unknown', truncated: false };
  const decoder = gzip ? zlib.createGunzip() : zlib.createBrotliDecompress();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of Readable.from([bytes]).pipe(decoder)) {
      const remaining = MAX_DECODED - size;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size = MAX_DECODED;
        truncated = true;
        decoder.destroy();
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } catch (error) {
    if (!truncated) return { bytes, format: 'unknown compression', truncated: false };
  }
  return { bytes: Buffer.concat(chunks, size), format: gzip ? 'gzip' : 'brotli', truncated };
}

async function inspectAsset(bytes, name) {
  const decoded = await decodedBytes(bytes, name);
  const content = decoded.bytes.toString('latin1');
  const lower = content.toLowerCase();
  const hits = [];
  for (const term of TERMS) {
    let index = -1;
    let found = 0;
    while ((index = lower.indexOf(term, index + 1)) !== -1 && found++ < 10 && hits.length < 80) {
      hits.push({
        term, offset: index,
        around: content.slice(Math.max(0, index - 35), index + term.length + 35)
          .replace(/[^\x20-\x7e]/g, ' ').trim(),
      });
    }
  }
  return {
    compressedBytes: bytes.length,
    decodedBytes: decoded.bytes.length,
    format: decoded.format,
    truncated: decoded.truncated,
    magic: bytes.subarray(0, 8).toString('hex'),
    hits,
  };
}

module.exports = { inspectAsset, decodedBytes };
