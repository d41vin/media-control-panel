# Manual verification checklist

How to test every feature by hand and what to expect. The automated layers
(`npm test`, `npm run harness`, `npm run e2e`, `npm run youtube-check`) cover
most of this — this checklist is the human pass on real Chrome with real
sites, and it is the only place where **actual audibility** can be judged.
Chrome is the primary verified browser: the automated layers were last run in
Google Chrome **156.0.8078.76** on 2026-11-04. Edge remains available as an
optional secondary browser (`MCP_BROWSER=edge`).

**Setup:** `chrome://extensions` → Developer mode → **Load unpacked** → select
`extension/`. After every code update click **Reload** on the extension card
and reopen the popup (stale assets are the #1 "it's broken" cause).

## Cards and playback

| # | Feature | How to test | Expected |
|---|---|---|---|
| 0 | Install | Load unpacked; click the **puzzle piece** in the toolbar | "Media Control" listed → **pin it**; icon visible on dark *and* light toolbars |
| 1 | Detection | Open YouTube, play any video; click the toolbar icon | One card: artwork/favicon, video title, `YOUTUBE.COM`, equalizer badge + pause icon |
| 2 | Card anatomy | Look at a card | Art + title + source on top, seek bar with times, controls row below — **no details chevron anywhere** |
| 3 | Artwork | Open a site that sets mediaSession artwork (e.g. YouTube) | Card art shows the media artwork; sites without it fall back to favicon, then letter tile |
| 4 | Playing state | Pause the video in the tab; reopen the popup | Card shows play icon, no equalizer, lighter title; sorts below playing cards |
| 5 | Card play/pause | Click the card's play/pause button | The tab's video starts/stops; card icon flips |
| 6 | Exclusive playback | Two tabs playing → `Alt+click` play on one card | The clicked tab plays, the other pauses; nothing changes if the clicked card has no playable media |
| 7 | Seek | Drag the position slider | Video jumps; readout matches the page player |
| 8 | ±10 s | Click `−10S` / `+10S` | Page skips 10 s back/forward |
| 9 | Volume popover | Click the speaker icon, drag the slider | Element volume follows in 5 % steps; popover readout matches the value; closing and reopening shows the real value (a fresh read, no stale snapshot); a site that listens to `volumechange` (fixture `test/volume-sync.html`) moves its own indicator |
| 9b | Two audio truths | Open the volume popover and look at the two state rows | `TAB AUDIO` shows the browser tab mute, `PLAYER AUDIO` shows the page player's own mute — they can disagree; each row toggles only its own state (the player row writes the element, never the tab) |
| 9c | Native player mute recognized | Mute the player on the site itself (its own button) | The popover's `PLAYER AUDIO` row flips to `Muted` (accent) within a second while the card is open; `TAB AUDIO` stays `Unmuted` |
| 9d | Player mute survives the site | On YouTube, click `PLAYER AUDIO` once to mute, then switch away and back to the tab; wait a few seconds | It stays muted (the player's own API is the mute channel — the site cannot reassert it back to unmuted). Unmute from the popover restores sound even after the site muted itself first |
| 9e | Real-site mute matrix | `npm run youtube-check` (needs internet) | `13/13 real-site checks passed`: extension mute/unmute on the active and backgrounded tab, native mute reflected in the popover, extension unmute overriding a native mute, tab mute independence, and actual playback at 2× / 2.5× / 4× / 8× / 16× |
| 10 | LIVE | Open a live stream | Seek slider replaced by red `LIVE` tag; ±10 s disabled |
| 11 | Multi-element | Fixture page (`npm run serve` → `localhost:8080/test/media-page.html`) | Site line shows `· ×N`; controls target the playing element |
| 12 | Switch tab | Click a card title (or the menu's `Switch to tab`) | Jumps to that tab and focuses its window |
| 13 | Close tab | Menu → `Close tab` | Tab closes; card disappears; badge updates |
| 14 | PiP | Click `PIP` on a video card | Floating video window; button accent while active; click again to return. No PiP button on audio-only cards |
| 15 | Track adapters | Open YouTube / Spotify / SoundCloud | `⏮` `⏭` flank the timeline on that card only; `⏭`/`⏮` skip tracks. On the first playlist video YouTube hides its prev button and the popup's `⏮` is disabled (hidden/aria-disabled/disabled all count) |
| 16 | Tab mute | Click the speaker icon in the card head | Tab silenced **without pausing**; struck-speaker badge appears; hold for 3+ s — it stays muted, the icon stays struck, and the tab strip agrees. Unmute restores . The popover's `TAB AUDIO` row shows and toggles the same state |
| 17 | Mute tabs / Unmute tabs | Two tabs playing → `MUTE TABS` | Browser tab audio muted in both; label flips to `UNMUTE TABS`; click restores. The players' own mute state is untouched |
| 18 | Pause all | `PAUSE ALL` | Every playing tab pauses, embeds included |
| 19 | Badge | Play media in two tabs | Badge shows `2`; pause both → badge disappears |
| 20 | Pin target | Menu → `Pin as target` | Card border turns accent; footer `TARGET · site`; menu reads `Unpin target` |
| 21 | Keyboard: target | With a pin, press `Alt+Shift+Space` anywhere | Pinned tab's media toggles without the popup |
| 22 | Keyboard: pause all | Press `Alt+Shift+P` | Every playing tab pauses, embeds included |
| 23 | Keyboard: mute tabs | Press `Alt+Shift+M` twice | Browser tab audio muted everywhere audible, then the extension-muted tabs unmute (player mute states untouched) |
| 24 | Keyboard: rows | Focus a card's play button, press `↓` / `↑` | Focus walks cards with a visible ring, wrapping at the ends |
| 25 | Keyboard: seek | Focus a card, press `→` then `←` | Media skips +10 s / −10 s |
| 26 | Keyboard vs sliders | Tab to any slider, press all four arrows | Slider adjusts with ↑ ↓ ← →; no card navigation, no ±10 s seek fires |
| 27 | Recently playing | Pause everything, close and reopen the popup | Paused media tabs stay listed (resumable) |
| 28 | Empty state | Nothing playing | Big `0`, "NOTHING PLAYING" |
| 29 | Appearance | Settings → Appearance: click System, Light, Dark | The whole popup repaints immediately (cards, popovers, switches, disabled controls); System is the default; the choice survives close/reopen. No theme-coloured gap around the square browser frame |
| 30 | Cross-origin embed | Fixture page | YouTube iframe player counted and controlled |
| 31 | Settings panel | Click the gear in the header | Panel opens: Appearance + three toggles + "stored on this device only"; `Esc` closes it |
| 32 | Auto-pause on open | Enable the toggle, play media in a tab, reopen the popup | Every playing tab pauses as the list appears; badge drops accordingly |
| 33 | Badge toggle | Play media, toggle the badge off / on | Badge disappears and reappears immediately, without reopening the popup |
| 34 | Recently-playing toggle | Toggle off while paused media cards are listed | Those cards leave immediately; next open lists only sound/muted/pinned tabs |
| 35 | Popovers | Open volume, then boost, then a menu; click elsewhere; press `Esc` | Only one popover open at a time; click-away and `Esc` close it |

## Global speed

| # | Feature | How to test | Expected |
|---|---|---|---|
| 36 | Global bar | Look under the header | `SPEED − 1.00× + ↺`; reset disabled at 1.00×; `−`/`+` disabled at 0.25× / 16.00× |
| 36b | High-speed range | Set 2×, 4×, 8×, 16× (global or per card) on a video | Playback really runs at the requested rate (watch the video speed, not just the readout); the card shows the actual element rate. YouTube's own speed menu may still display 2× — that is its menu cap, not the playback rate |
| 37 | Global stepping | Click `+` twice | `1.50×`; playing media in every inheriting tab speeds up within a second |
| 38 | Global persistence | Set 1.50×, restart the browser, reopen | Bar shows `1.50×`; new media starts at 1.50× |
| 39 | Applies to new media | Start a paused video with global at 1.50× | It plays at 1.50× from the start |
| 40 | Applies to new pages | Set the global speed FIRST, then open a fresh tab and play media | Plays at the global rate from the start — the tab receives the policy on its first injectable document even though it did not exist when the speed was chosen |
| 40b | Player announce reset | On YouTube, set global 2×, open a video (or click Next) | The video plays at 2.00×, not 1.00×: the player's own 1.00× initialization write is re-stamped, not adopted as an override |
| 41 | Reset global | Click `↺` | Back to `1.00×`; inheriting media returns to 1.00× |

## Per-page speed overrides

| # | Feature | How to test | Expected |
|---|---|---|---|
| 42 | Card stepper | Click `+` on one card | That tab's media changes 0.25×; other tabs unaffected |
| 42b | Step from observed | With the card showing a site-set 1.10× (see #47), click `+` | It steps to `1.35×` — 0.25 from the observed rate, not snapped to the grid |
| 42c | Disabled adapters | On a non-adapter site | Prev/next stay in place in the timeline, grayed and unclickable; tooltips explain; ±10 s disable on live streams |
| 42d | Adapter disabled state | On YouTube with no next video (end of a playlist) | The next button reflects the site's own disabled state where the site exposes it |
| 43 | Override marker | With an override active | Value accent + dotted underline; `↺` appears; tooltip names both rates; global bar counts `1 PAGE OVERRIDE` |
| 44 | Global doesn't fight it | Change the global speed | Overridden tab keeps its rate; inheriting tabs move |
| 45 | Native player respect | On YouTube, pick 1.5× in the site's own speed menu | Card shows `1.50×` as a page override and never snaps it back |
| 45b | Extension speed reaches YouTube's menu | Set a page speed from the card stepper (or the global bar) on YouTube | The video plays at the requested rate AND YouTube's own speed menu/indicator follows where its internal player methods exist (the adapter uses the feature-detected internal `#movie_player` interface — undocumented and changeable, not the official IFrame API). YouTube's menu tops out at 2.00×; above that the media still runs faster and the card shows the element's real rate |
| 45c | Extension volume reaches YouTube's indicator | Move the volume slider on a YouTube card | The audio changes and YouTube's own volume UI follows through the same internal player methods; the popup readout shows the value that actually landed. Without those methods the element volume still applies and the readout stays truthful |
| 46 | Exact rates | Site sets 1.10× (e.g. via its menu or JS) | Card shows `1.10×` — never rounded to the 0.25× grid |
| 47 | Observed rate at 1.00× | Global 1.00×, no override; a site plays at its own non-default rate | Card shows the site's actual rate (tooltip: "Website-set rate") — not a false `1.00×`; a step from the card builds on that rate |
| 48 | Reset to global | Click the card's `↺` | Media returns to the global rate; override marker gone |
| 49 | Override persistence | Set an override, close/reopen the popup | Card still shows it; media still at that rate |
| 50 | Navigation clears | With an override, navigate the tab elsewhere | Override gone; new page inherits global |
| 50c | SPA keeps the override | On YouTube, set an override, click to another video (no full reload) | Override survives; the new video follows it — including when the player writes its own 1.00× while setting the next video up (the policy belongs to the document, not the element) |
| 50g | Reload clears the override | Set an override, press Ctrl+R | The override is gone (a reload is a new document); the page inherits global |
| 50h | Hash keeps the override | Set an override, follow an in-page anchor (`#section`) | The override and the applied rate survive |
| 50i | Iframe media | Page with an embedded same-origin player; change speed with the site's control inside the frame | The card adopts the frame's rate as the page override (current frame documents are accepted) |
| 50j | Silent existing tab | Open a page with no media and leave it silent (not audible/muted/recent/pinned); set global 2×; start a video there | The video starts at 2.00×; resetting global returns later media to 1.00× |
| 50d | Source change keeps the rate | With a policy active, make the site reload its source (quality switch, next episode in-place) | The element returns to the policy rate (defaultPlaybackRate stamping) |
| 50e | Reset reaches paused media | Set an override, pause the media, reset to global | The paused element moves to the global rate immediately; on resume it does not jump back |
| 50b | Managed tab stays governed | Global 2×, then pause the media and let the tab age out of the recent list; reset global to 1× | The tab's media still returns to 1.00× — previously managed tabs hear the policy even when detection no longer lists them |
| 50f | Rapid use stays consistent | Change global speed several times quickly while media plays and native rate changes happen; then step a page speed three times fast | Final values equal the last choices; nothing drifts back to an older rate |

## Tab volume boost

| # | Feature | How to test | Expected |
|---|---|---|---|
| 51 | Boost chip | Look at cards | The **viewed tab's** card shows an enabled `100%` pill (distinct from the volume speaker); background tabs' chips are disabled with "switch to this tab first" — the platform only allows capture targets with the activeTab grant |
| 52 | Enable | With the media tab in front, open the boost popover and move the slider to 250 % | Browser shows the tab recording indicator; chip turns accent `250%`; audio gets louder |
| 53 | **Audibility (ears required)** | Listen while boosting a tab | Sound at normal level at 100 %, louder above, **not silent, not doubled, not leaking from other tabs** |
| 54 | Gain updates | Drag the slider while active | Loudness follows smoothly; no clicks, no restart of the pipeline |
| 55 | Volume independence | Change element volume / mute the tab while boosted | Output scales with them (multiplicative, like a mixer); boost value unchanged |
| 56 | 100 % stops the pipeline | Drag the active slider back to 100 % (or press Reset) | Recording indicator disappears; chip back to quiet `100%`; offscreen document released (no leftover audio graph) |
| 57 | Distortion warning | Boost to 500–600 % | Audible distortion possible; limiter tames the worst peaks — the popover warns about this |
| 58 | Popup close | Close the popup while boosted | Boost keeps working (offscreen owns it); reopen shows the active state truthfully |
| 59 | Navigation keeps the boost | Start a boost, then navigate the boosted tab: a link, SPA pushState, hash change, hard reload, or a different site | Boost keeps working and the chip stays active — capture is tab-level and does not restart. Only Reset to 100 %, tab close, or the stream ending stops it |
| 59b | Repeated use | Boost → adjust several times → reset to 100 % → boost again | Exactly one capture pipeline at a time; reset releases it fully; the restart starts a fresh capture cleanly (`npm run verify-capture` exercises this with real clicks) |
| 59c | Cancel while starting | Drag the slider above 100 %, then immediately reset to 100 % and/or navigate the tab; repeat a few times | No orphaned capture, no audio leak, the recording indicator disappears, and a following boost start works — the UI never sticks on "starting" |
| 59d | Toolbar invocation grants capture | Click the real toolbar icon and start boost on the viewed tab | Capture starts under the declared `activeTab` grant (this exact path — a real toolbar click — is the one automation cannot perform; `npm run verify-capture` records the programmatic refusal otherwise) |
| 59e | Startup deadline | Start boost on a tab whose capture hangs (e.g. a page that refuses capture slowly) | After ~12 s the chip shows a truthful error; no recording indicator lingers; a retry works |
| 59f | Failure cleanup | Force a failed boost attempt, watch for a few seconds | The browser recording indicator disappears; the offscreen document is released (the popup never claims active) |
| 60 | Tab close | Close a boosted tab | Boost state clears; nothing lingers |
| 61 | Failure truth | Open the popup programmatically or on a page without the invocation grant | Popover shows the browser's capture error; chip never fakes "active" (also exercised by `npm run verify-capture`) |
| 62 | Two boosts | Boost a tab, switch to another media tab, boost it too | Each tab's audio scales independently; exactly one offscreen document serves both |
| 63 | Long pause | Boost a tab, pause its media for minutes, resume | The pipeline survives the pause (offscreen uses the USER_MEDIA reason — no 30 s silence shutdown) and the resumed audio is boosted |

**Known caveats:** DRM sites may refuse element-level seek; closed shadow
roots and WebAudio-only playback are invisible to every extension in this
category; `chrome://` pages can be muted but not controlled; MediaStream
(`srcObject`) live previews cannot hold a playbackRate and are skipped by the
speed manager; the browser or OS may claim a suggested shortcut
(remap at `chrome://extensions/shortcuts`); the speed manager
adopts a page-originated rate change after the media has settled, including a
site re-applying the rate last chosen in its own menu on a later video (the
browser does not expose the difference) — writes made while a new video is
still initializing are treated as setup and re-stamped, so a player's own
1.00× announcement does not clobber the policy; the card shows what actually
happened and the reset button is the escape hatch. Boost capture requires the
`activeTab` grant on the target tab (declared in the manifest; a real toolbar
invocation grants it) — starting capture on a background tab is refused by the
browser, which is why the control is gated to the viewed tab. A site that owns its player UI and ignores the standard `volumechange`/`ratechange`
events is synchronized only through a feature-detected adapter: on YouTube the
extension uses the first-party player's **internal** `#movie_player` methods
(undocumented, not the official YouTube IFrame Player API, and changeable — the
adapter no-ops safely when they are missing). Spotify and SoundCloud's web
players expose no reliable public API for this, so their native UI
synchronization is unsupported; the popup readout and element state stay
truthful while the site keeps its own indicator. Verify YouTube's
menu/indicator sync by hand (#45b, #45c). The action popup's outer frame is
browser-owned and square on Chrome; the document paints the theme paper edge to
edge (no gap) and the rounded cards/popovers are the inner surface. Verify
visually with the extension loaded, in both themes.
