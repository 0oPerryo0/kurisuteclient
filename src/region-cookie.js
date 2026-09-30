// The FANZA guide edits ckcy_remedied_check on .dmm.co.jp, not ckcy on .dmm.com.
// Limit outgoing navigation overrides to the region gate and game pages.
function isDmmGamePage(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return false;
    if (host === 'special.dmm.co.jp')
      return /^\/not-available-in-your-region\/?$/.test(parsed.pathname);
    if (host === 'play.games.dmm.co.jp') return true;
    if (host === 'games.dmm.co.jp')
      return true;
    return (host === 'dmm.co.jp' || host === 'www.dmm.co.jp') &&
      /^\/netgame(?:\/|$)/.test(parsed.pathname);
  } catch { return false; }
}

function withRegionCookie(cookieHeader = '') {
  const others = String(cookieHeader).split(';').map((part) => part.trim())
    .filter((part) => part && !/^ckcy_remedied_check\s*=/i.test(part));
  return ['ckcy_remedied_check=ec_mrnhbtk', ...others].join('; ');
}

const COOKIE_NAME = 'ckcy_remedied_check';
const COOKIE_VALUE = 'ec_mrnhbtk';

function isDmmRegionCookie(cookie) {
  const domain = cookie.domain?.replace(/^\./, '').toLowerCase();
  return cookie.name === COOKIE_NAME &&
    (domain === 'dmm.co.jp' || domain?.endsWith('.dmm.co.jp'));
}

function cookieUrl(cookie) {
  return `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
}

async function syncRegionCookie(cookies) {
  const existing = (await cookies.get({ name: COOKIE_NAME })).filter(isDmmRegionCookie);
  if (!existing.some((cookie) => cookie.domain.replace(/^\./, '').toLowerCase() === 'dmm.co.jp' && cookie.path === '/')) {
    await cookies.set({ url: 'https://www.dmm.co.jp/', domain: '.dmm.co.jp', path: '/',
      name: COOKIE_NAME, value: COOKIE_VALUE, secure: true });
  }
  for (const cookie of existing) {
    if (cookie.value === COOKIE_VALUE) continue;
    await cookies.set({ url: cookieUrl(cookie), domain: cookie.domain, path: cookie.path,
      name: COOKIE_NAME, value: COOKIE_VALUE, secure: cookie.secure,
      httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
      ...(cookie.session ? {} : { expirationDate: cookie.expirationDate }) });
  }
}

async function removeRegionCookie(cookies) {
  const existing = (await cookies.get({ name: COOKIE_NAME })).filter(
    (cookie) => isDmmRegionCookie(cookie) && cookie.value === COOKIE_VALUE,
  );
  for (const cookie of existing) await cookies.remove(cookieUrl(cookie), COOKIE_NAME);
}

module.exports = { isDmmGamePage, withRegionCookie, isDmmRegionCookie, syncRegionCookie, removeRegionCookie };
