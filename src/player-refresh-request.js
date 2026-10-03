const { protobufLayout } = require('./player-api-wire');

// Only the empty InitGameDataCs payload identified in HotUpdate.dll is eligible.
// Successful response pairing is required separately. This is not proof that the
// server has no initialization side effects; refreshing requires presence consent.
function isPlayerRefreshRequest(bytes) {
  if (!bytes || bytes.byteLength > 8192) return false;
  const fields = protobufLayout(bytes)?.fields;
  if (!fields || fields.length > 5) return false;
  const seen = new Set();
  for (const field of fields) {
    if (seen.has(field.number)) return false;
    seen.add(field.number);
    if (field.number === 1) { if (field.wireType !== 0 || field.byteLength > 5) return false; }
    else if ([2, 3, 4].includes(field.number)) {
      if (field.wireType !== 2 || field.byteLength > 2048) return false;
    } else if (field.number === 100) {
      if (field.wireType !== 2 || field.byteLength !== 0) return false;
    } else return false;
  }
  return seen.has(1) && seen.has(100);
}

module.exports = { isPlayerRefreshRequest };
