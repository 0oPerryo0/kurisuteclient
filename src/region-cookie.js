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

// DMM sets ckcy=2 on dmm.co.jp for visitors outside Japan; mainland China users
// still hit the region gate with only ckcy_remedied_check overridden.
const REGION_COOKIES = new Map([['ckcy_remedied_check', 'ec_mrnhbtk'], ['ckcy', '1']]);

function withRegionCookie(cookieHeader = '') {
  const others = String(cookieHeader).split(';').map((part) => part.trim())
    .filter((part) => part && !REGION_COOKIES.has(part.split('=')[0].trim().toLowerCase()));
  return [...REGION_COOKIES].map(([name, value]) => `${name}=${value}`).concat(others).join('; ');
}

function isRegionValue(cookie) {
  return REGION_COOKIES.has(cookie.name) && REGION_COOKIES.get(cookie.name) === cookie.value;
}

function isDmmRegionCookie(cookie) {
  const domain = cookie.domain?.replace(/^\./, '').toLowerCase();
  return REGION_COOKIES.has(cookie.name) &&
    (domain === 'dmm.co.jp' || domain?.endsWith('.dmm.co.jp'));
}

function cookieUrl(cookie) {
  return `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
}

async function syncRegionCookie(cookies) {
  for (const [name, value] of REGION_COOKIES) {
    const existing = (await cookies.get({ name })).filter(
      (cookie) => cookie.name === name && isDmmRegionCookie(cookie));
    if (!existing.some((cookie) => cookie.domain.replace(/^\./, '').toLowerCase() === 'dmm.co.jp' && cookie.path === '/')) {
      await cookies.set({ url: 'https://www.dmm.co.jp/', domain: '.dmm.co.jp', path: '/',
        name, value, secure: true });
    }
    for (const cookie of existing) {
      if (cookie.value === value) continue;
      await cookies.set({ url: cookieUrl(cookie), domain: cookie.domain, path: cookie.path,
        name, value, secure: cookie.secure,
        httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
        ...(cookie.session ? {} : { expirationDate: cookie.expirationDate }) });
    }
  }
}

async function removeRegionCookie(cookies) {
  for (const name of REGION_COOKIES.keys()) {
    const existing = (await cookies.get({ name })).filter(
      (cookie) => cookie.name === name && isDmmRegionCookie(cookie) && isRegionValue(cookie),
    );
    for (const cookie of existing) await cookies.remove(cookieUrl(cookie), name);
  }
}

module.exports = { isDmmGamePage, withRegionCookie, isDmmRegionCookie, isRegionValue, syncRegionCookie, removeRegionCookie };
