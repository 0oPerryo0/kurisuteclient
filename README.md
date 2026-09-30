# クリステの遺宝 Desktop (prototype)

Unofficial Windows 11 browser wrapper for the [DMM/FANZA game page](https://games.dmm.co.jp/detail/charsapple_x_879635). It does not include the game or request your credentials; log in on DMM's own pages. You must meet the site's age requirements.

## Run

Install Node.js, then in this folder run `npm.cmd install` and `npm.cmd start` in PowerShell. This is a development prototype, not an installer yet. Run `npm.cmd run check` for JavaScript syntax checks.

## Controls

Pin (always on top), Game only, fullscreen, mute, zoom, reload, home and screenshots are available in the toolbar. Settings and the DMM session persist in the Electron user-data directory. Login/payment pop-ups stay inside sandboxed Electron windows; non-HTTPS navigation is blocked.

The minimum window content size is the 1136 × 640 game viewport plus the 48-pixel toolbar, scaled with the Zoom setting; Windows title-bar and border dimensions are included in the actual minimum window size.

**Game only** is enabled by default. After DMM launches the game on `play.games.dmm.co.jp`, it hides the surrounding portal and uniformly scales the 1136 × 640 game to the largest size that fits the window. At a matching aspect ratio, the game fills the area; otherwise it remains centered with only the outer space colored. The actual `games.mofushippo.com` canvas is not modified. It does not change the game's URL or move its iframe. The DMM detail/login pages remain untouched. If the site changes its layout or you need portal controls, turn Game only off. The **Layout report** button saves a JSON file containing only frame origins, element dimensions and computed colors (not login details, page text or URL paths) for diagnosing layout. Review the file before sharing.

In Game only mode the client samples the four edges of the visible game every four seconds and blends those colors into the outer space only. No mask or fade is applied to game pixels. Only four average colors are sent to the DMM page; the captured pixels stay in the local Electron process and are not saved or injected into the web page. Until the first sample, the surround uses a dark neutral color.

**FPS is experimental.** 30/60/120/144 throttle `requestAnimationFrame` callbacks in reachable page frames. Native disables the throttle. It may not affect a game that captures its own frame scheduler before injection, uses a different rendering loop, or applies an internal FPS cap. Choosing 120/144 does **not** guarantee an unlock beyond the game's default, display refresh rate, or Chromium's scheduling. Throttling may affect animations/game timing. Test in-game before relying on it. No browser security protections are disabled to make this work.

The initial page can redirect to age verification, DMM sign-in or another game origin. This prototype has not been verified with a signed-in account. Do not enter credentials into an unexpected domain.
