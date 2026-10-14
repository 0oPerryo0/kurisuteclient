const DEFAULT_WINDOW_TITLE = 'クリステの遺宝 Desktop';
const UPDATE_NOTICE = 'New update is available';

// notice is short client status text such as UPDATE_NOTICE or download progress, appended last.
function playerWindowTitle(originalTitle, player, updateNotice = null) {
  const notice = updateNotice ? ` | ${updateNotice}` : '';
  if (!player) return originalTitle + notice;
  const number = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? String(value) : '?';
  const nickname = typeof player.nickname === 'string' ? [...player.nickname
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim()].slice(0, 48).join('') : '';
  const age = player.staminaLastRead && Number.isSafeInteger(player.staminaAgeMinutes) && player.staminaAgeMinutes >= 1
    ? ` (last read ${player.staminaAgeMinutes}m ago)` : player.lastKnown ? ' (last known)' : '';
  return `${originalTitle} | ${nickname || 'Player'} Level: ${number(player.level)} Stam: ${number(player.stamina)}${age}${notice}`;
}

function attachPlayerWindowTitle(window, originalTitle = DEFAULT_WINDOW_TITLE) {
  let player = null, updateNotice = null;
  const apply = () => {
    if (!window.isDestroyed()) window.setTitle(playerWindowTitle(originalTitle, player, updateNotice));
  };
  window.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault(); originalTitle = title || DEFAULT_WINDOW_TITLE; apply();
  });
  apply();
  return {
    setPlayer(value) { player = value; apply(); },
    setUpdateNotice(value) { updateNotice = value || null; apply(); },
  };
}

module.exports = { DEFAULT_WINDOW_TITLE, UPDATE_NOTICE, playerWindowTitle, attachPlayerWindowTitle };
