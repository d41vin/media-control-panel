# Manual verification checklist

How to test every feature by hand and what to expect. The automated layers
(`npm test`, `npm run e2e`, the mock harnesses) cover most of this — this
checklist is the human pass on real Chrome with real sites.

**Setup:** `chrome://extensions` → Developer mode → **Load unpacked** → select
`extension/`. After every code update click **Reload** on the extension card
and reopen the popup (stale assets are the #1 "it's broken" cause).

| # | Feature | How to test | Expected |
|---|---|---|---|
| 0 | Install | Load unpacked; click the **puzzle piece** in the toolbar | "Media Control" listed → **pin it**; icon = white square, black triangle, red dot — visible on dark *and* light toolbars |
| 1 | Detection | Open YouTube, play any video; click the toolbar icon | One row: index `01`, favicon, video title, `YOUTUBE.COM`, equalizer bars + pause icon |
| 2 | Playing state | Pause the video in the tab; reopen the popup | Row shows play icon, no equalizer, lighter title; sorts below playing rows |
| 3 | Row play/pause | Click the row's play/pause icon | The tab's video starts/stops; row icon flips |
| 4 | Badge | Play media in two tabs | Badge shows `2`; pause both → badge disappears |
| 5 | Tab mute | Click the speaker icon on a row | Tab silenced without pausing; icon becomes struck speaker; unmute restores |
| 6 | Mute all / Unmute all | Two tabs playing → `MUTE ALL` | Both muted; label flips to `UNMUTE ALL`; click restores |
| 7 | Expanded panel | Click a row's chevron | Panel slides open: `POSITION` with times, `VOLUME %`, `SPEED ×`, `−10S +10S PIP TAB PIN CLOSE` |
| 8 | Seek | Drag the position slider | Video jumps; readout matches the page player |
| 9 | ±10 s | Click `−10S` / `+10S` | Page skips 10 s back/forward |
| 10 | Volume | Drag `VOLUME` to ~30% | Element volume drops; readout `30%` |
| 11 | Speed | Drag `SPEED` to 1.50× | Video plays faster (YouTube may reset during ads — element-level limit) |
| 12 | PiP | Click `PIP` | Floating video window; button red while active; click again to return |
| 13 | LIVE | Open a live stream | Seek slider replaced by red `LIVE` tag; ±10 s disabled |
| 14 | Multi-element | Fixture page (`npm run serve` → `localhost:8080/test/media-page.html`) | Site line shows `· ×N`; controls target the playing element |
| 15 | Switch tab | Click a row title (or `TAB`) | Jumps to that tab and focuses its window |
| 16 | Close tab | Click `CLOSE` | Tab closes; row disappears; badge updates |
| 17 | Pin target | Click `PIN` | Index turns red; footer `TARGET 01 · site`; button reads `UNPIN` |
| 18 | Keyboard: target | With a pin, press `Alt+Shift+Space` anywhere | Pinned tab's media toggles without the popup |
| 19 | Keyboard: pause all | Press `Alt+Shift+P` | Every playing tab pauses, embeds included |
| 20 | Keyboard: mute all | Press `Alt+Shift+M` twice | All audible tabs mute, then extension-muted tabs unmute |
| 21 | Recently playing | Pause everything, close and reopen the popup | Paused media tabs stay listed (resumable) |
| 22 | Empty state | Nothing playing | Big `0`, "NOTHING PLAYING" |
| 23 | Dark mode | System dark mode | Ink/paper swap, same layout |
| 24 | Cross-origin embed | Fixture page | YouTube iframe player counted and controlled |
| 25 | Track adapters | Open YouTube / Spotify / SoundCloud | `⏮` `⏭` flank play/pause on that row only |
| 26 | Next / prev | Click `⏭`, then `⏮` | Skips to next/previous track in the site's queue |
| 27 | Adapter persistence | On YouTube, navigate away from a video; reopen | Track buttons gone outside player context |
| 28 | Keyboard: rows | Focus a row's play button, press `↓` / `↑` | Focus walks rows with a visible ring, wrapping at the ends |
| 29 | Keyboard: seek | Expand a row, press `→` then `←` | Media skips +10 s / −10 s |
| 30 | Keyboard vs sliders | Tab to a slider, press arrows | Slider adjusts; no ±10 s seek fires |

**Known caveats:** DRM sites may refuse element-level seek; closed shadow
roots and WebAudio-only playback are invisible to every extension in this
category; `chrome://` pages can be muted but not play/paused; browsers may
claim a suggested shortcut (Edge takes `Alt+Shift+P`) — remap at
`chrome://extensions/shortcuts`.
