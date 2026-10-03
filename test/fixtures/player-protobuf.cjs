function varint(value) {
  value = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
function scalar(number, value) { return Buffer.concat([varint(number * 8), varint(value)]); }
function message(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function initialPlayerReply({ level = 42, stamina = 120 } = {}) {
  return Buffer.concat([
    scalar(1, 101), message(2, 'PRIVATE_USER_ID'), message(3, 'PRIVATE_PLAYER_ID'), message(4, 'PRIVATE_TOKEN'),
    message(101, Buffer.concat([
      scalar(2, level), message(4, 'PRIVATE_NAME'), scalar(7, stamina), scalar(5, 987654321),
      message(50, Buffer.concat([scalar(2, 99), message(4, 'PRIVATE_ROLE'), scalar(7, 999)])),
      message(8, 'PRIVATE_PROFILE'),
    ])),
  ]);
}
function initialPlayerRequest() {
  return Buffer.concat([scalar(1, 100), message(2, 'PRIVATE_USER_ID'), message(3, 'PRIVATE_PLAYER_ID'),
    message(4, 'PRIVATE_TOKEN'), message(100, Buffer.alloc(0))]);
}
module.exports = { varint, scalar, message, initialPlayerReply, initialPlayerRequest };
