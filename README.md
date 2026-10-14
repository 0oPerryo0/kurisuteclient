# クリステの遺宝 Desktop

Unofficial Windows client for the [DMM game page](https://games.dmm.co.jp/detail/charsapple_x_879635). It does not include the game. Log in on DMM's own pages. You must meet the site's age requirements.

## Download

Get `CristeDesktop-<version>.exe` from [Releases](https://github.com/0oPerryo0/kurisuteclient/releases). It is a portable app: no installer, just run the exe. Settings and your DMM login are kept between versions.

## Features

Everything is in the right-click menu.

- Game-only view with uniform scaling and an ambient background sampled from the game edges
- Fullscreen, always on top, mute, zoom
- FPS cap and speed control
- Screenshot
- Player level and stamina in the window title (local only)
- Optional Discord Rich Presence
- Game asset download and cache controls
- DMM region-cookie override (on by default)
- Game language selection (experimental, see below)
- Update check (see below)

## Game language (experimental)

The game ships its original Chinese text but only shows Japanese. **Game language** switches the language the game starts in, then reloads it:

| Option | What you see |
|---|---|
| 日本語 (original) | The unmodified game. This is the default. |
| 简体中文 | The game's built-in Simplified Chinese text. |
| 繁體中文（台灣，劇情保留原文） | Menus, items, skills and other UI text converted to Taiwan Traditional Chinese with [OpenCC](https://github.com/nk2028/opencc-js). Story dialogue stays in the original Simplified Chinese. |

The change is made only to the copy of the game data this app loads; nothing on the server changes. In Traditional Chinese mode, characters the game's font cannot draw are shown in their Japanese or Simplified form instead of as blanks. A few error messages built into the game code remain in Simplified Chinese.

## Updates

The app checks this repository's GitHub releases at startup and every 6 hours (right-click → **Updates**; can be turned off). When a newer version exists, **Download** saves the new exe next to the current one after checking its size and checksum, and can start it for you.

## Building from source

Requires Node.js and Windows.

```bash
npm ci
npm start        # run the client
npm test         # run the tests
npm run dist     # build dist/CristeDesktop-<version>.exe
```

## Disclaimer

This is an independent, third-party client. It is not affiliated with, endorsed by, or supported by DMM, FANZA, or the game’s developers or publishers. All game content, names, logos, and trademarks remain the property of their respective owners. No rights to that content are claimed.

Using this client, including its cookie-modification and game-language features, may violate a service’s terms and could result in restricted access or account suspension. Use it at your own risk. To the extent permitted by law, the client’s creator accepts no responsibility for account actions, data loss, or other consequences arising from its use. You are responsible for complying with applicable laws and service terms.
