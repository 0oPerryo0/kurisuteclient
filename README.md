# クリステの遺宝 Desktop (prototype)

Unofficial Windows 11 browser wrapper for the [DMM/FANZA game page](https://games.dmm.co.jp/detail/charsapple_x_879635). It does not include the game or request your credentials; log in on DMM's own pages. You must meet the site's age requirements.

## Run

Install Node.js, then in this folder run `npm.cmd install` and `npm.cmd start` in PowerShell. Run `npm.cmd run check` for JavaScript syntax checks.

Pushing this folder to GitHub runs `.github/workflows/windows-exe.yml` on a Windows runner. It tests the app and builds one unsigned portable exe, `CristeDesktop-0.0.2.exe`. Download it from that workflow run's Artifacts. It does not include the game. A portable Electron exe unpacks itself to a temporary folder when you launch it; that is still a single file to download. It is not code-signed, so Windows SmartScreen may warn on first launch.

## Controls

Right-click the game for Home, Reload, Pin, Game only, Fullscreen, Mute, Zoom, FPS, Speed, Screenshot, and the current status. Unity hook and the diagnostic reports are not in that menu. Settings and the DMM session persist in the Electron user-data directory. Login/payment pop-ups stay inside sandboxed Electron windows; non-HTTPS navigation is blocked.

The minimum window content size is the 1136 × 640 game viewport, scaled with the Zoom setting. There is no control bar. Windows title-bar and border dimensions are included in the actual minimum window size.

Most RAM is the game's Unity memory, which grew to roughly 640–890 MB in the loaded build and cannot be reduced without crashing it. The wrapper only avoids extra Chromium renderer processes, spellcheck, and a spare renderer. Restart the app after this change so those process limits apply.

**Game only** is enabled by default. After DMM launches the game on `play.games.dmm.co.jp`, it hides the surrounding portal and uniformly scales the 1136 × 640 game to the largest size that fits the window. At a matching aspect ratio, the game fills the area; otherwise it remains centered with only the outer space colored. The actual `games.mofushippo.com` canvas is not modified. It does not change the game's URL or move its iframe. The DMM detail/login pages remain untouched. If the site changes its layout or you need portal controls, turn Game only off. The **Layout report** button saves a JSON file containing only frame origins, element dimensions and computed colors (not login details, page text or URL paths) for diagnosing layout. Review the file before sharing.

In Game only mode the client samples the four edges of the visible game every four seconds and blends those colors into the outer space only. No mask or fade is applied to game pixels. Only four average colors are sent to the DMM page; the captured pixels stay in the local Electron process and are not saved or injected into the web page. Until the first sample, the surround uses a dark neutral color.

**FPS is experimental.** 30/60/120/144 throttle `requestAnimationFrame` callbacks in the game iframe. Native disables the throttle. It may not affect a game that captures its own frame scheduler before injection, uses a different rendering loop, or applies an internal FPS cap. Choosing 120/144 does **not** guarantee an unlock beyond the game's default, display refresh rate, or Chromium's scheduling. Throttling may affect animations/game timing. Test in-game before relying on it. No browser security protections are disabled to make this work.

**Speed forces the game frame's browser clock.** Unity's static `TimeCommands.SetTimeScale` cannot be called from JavaScript, and changing animation-frame timestamps did not speed this build up. The Speed control instead makes `performance.now()` in `games.mofushippo.com` advance at 1×/2×/3×/5×/10× when that frame loads. It does not pause navigation. Unity WebGL normally measures frame time from that clock. This does not modify the Unity project, DMM pages, `Date.now()`, server-side timers, or audio. If the game already started, reload it after changing speed. A build that captured the native clock before injection, or that ignores browser time, will stay at normal speed.

For a game build you control, attach a component with a public method to a persistent GameObject, then enter its name and method in Unity hook. For example:

```csharp
using UnityEngine;

public class ClientSpeedBridge : MonoBehaviour
{
    public void SetTimeScale(float value) => Time.timeScale = Mathf.Clamp(value, 1f, 10f);
}
```

Attach that component to a GameObject named `ClientSpeedBridge`, then set the hook's object to `ClientSpeedBridge` and method to `SetTimeScale`. Set Speed back to 1× before disabling the hook. Unity `Time.timeScale` affects scaled game-time systems, not unscaled timers, server actions or audio pitch.

**Try guesses at 1×** in Unity hook manually probes 24 likely GameObject/method pairs via `SendMessage`, waits briefly for Unity console errors, then offers to save `criste-unity-guesses.json`. It does not enable a hook or probe above 1×. If the hook was enabled, it temporarily sends 1× through your configured target, then reapplies your selected speed afterward. A “no detected error” result is only a lead, not proof of a matching method. Review the report before sharing it.

**Inspect Unity runtime** scans every export of the already loaded Unity module. It saves only SendMessage export names, names mentioning time, scale, il2cpp or the debug console, and whether the generic float-call helpers `dynCall_vf` or `dynCall_vif` exist. It does not call them or read their values. The result is `criste-unity-runtime.json`. Generic `dynCall_*` helpers are not a speed API; they need a function pointer this page does not export. **Find setter pointer** searches the whole loaded Unity heap for `SetTimeScale` and `time.scale`, then records addresses and a few preceding pointer words. It may pause the game for up to 20 seconds. It does not call a function or save asset bytes. The result is `criste-unity-pointers.json`. A string with no pointer is only stored data, not a callable method.

**Analyze Unity build** inspects up to eight static Unity resources that the signed-in game frame already requested. It reads at most 26 MiB of each compressed asset, locally decompresses gzip/Brotli (up to 96 MiB of output), and saves only bounded speed-related string matches, offsets, format and asset basenames in `criste-unity-build-report.json`. When present, it also parses `global-metadata.dat` in memory and reports speed-related IL2CPP type/method names, assembly, static/public flags and parameter type indices (not resolved C# type names). It never saves full assets, full URLs, cookies or request headers. An unsupported metadata version or a stripped, encrypted or larger build may yield no useful declarations. Review the report before sharing it.

The **Timing report** records timing counters, canvas dimensions and names of common engine globals, sampled 1.2 seconds apart. It contains no cookies, request URLs or page text. Review it before sharing. It was used to confirm that the game runs Unity WebGL and ignores the previous callback-timestamp speed experiment.

The initial page can redirect to age verification, DMM sign-in or another game origin. This prototype has not been verified with a signed-in account. Do not enter credentials into an unexpected domain.
