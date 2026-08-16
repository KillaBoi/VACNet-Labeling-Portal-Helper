# VACNet Review Enhancer

<a href="https://raw.githubusercontent.com/KillaBoi/VACNet-Labeling-Portal-Helper/main/vacnet-enhancer.user.js"><img src="https://img.shields.io/badge/INSTALL%20NOW-click%20here-brightgreen?style=for-the-badge" alt="Install now" height="42"></a>
<br><sub>Opens the raw userscript. With <a href="https://www.tampermonkey.net">Tampermonkey</a> or <a href="https://violentmonkey.github.io">Violentmonkey</a> installed it shows an install prompt. If you just see code, the manager is not installed or is not detecting it.</sub>

A userscript that turns the CS2 VACNet labelling portal (`counter-strike.net/vacnet/clips`) into a fast, keyboard-driven review tool: full-VOD seeking, colour-coded one-key verdicts and presets, a persistent history archive, and shareable labels for reviewing as a group.

![The enhanced review page](screenshots/main.png)

> ⚠️ **This is a productivity tool, not an automation tool.** It does not auto-answer or "farm" labels to earn invites for your friends/family/mother/father/sister/brother. Its only real use is to make watching and clicking faster.
>
> 🙏 **Do not let anything outside the Valve-assigned clip window influence your verdict.** For example, a player may toggle earlier in the match, but if the 10-12 second clip you were given does not show it, labelling on that outside knowledge mislabels the clip.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net) or [Violentmonkey](https://violentmonkey.github.io).
2. Click **INSTALL NOW** above (or open [`vacnet-enhancer.user.js`](vacnet-enhancer.user.js) and press **Raw**); your script manager shows an install prompt. Fallback: create a new script and paste the file contents.
3. Open the portal. The wide two-column layout kicks in above 1400px window width.

It keeps itself current: the version tag in the bottom-right corner turns green (`⬆ update available`) when a newer build is on GitHub, and clicking it reinstalls. Tampermonkey's own "check for updates" works too.

## Features

### Full-VOD player

The portal normally clamps playback to the ~10s assigned clip and snaps you back if you scrub outside it. The script removes that clamp at page load, so the native seekbar covers the entire demo, and marks it up:

- **orange band** = the assigned clip, **red tick** = the event moment, **green bands** = parts of this VOD you already labelled.
- a **clip bar** under the video with its own scrubber, transport, playback rate, task id/link and match id.
- **clip lock** — a checkbox that puts the original clip-only behaviour back if you'd rather not stray past the demo; it persists across clips.
- **out-of-clip warning** — an amber banner appears whenever playback leaves the assigned window; click it to jump back to the clip start.

### One-key verdicts

Each question becomes colour-coded **Yes / Unsure / No**, driveable entirely from the keyboard, with preset buttons and hotkeys for the common calls (LEGIT, AIM, WH, RAGE) plus a reset.

![Verdict panel with presets](screenshots/verdicts.png)

### Control bar

Everything you need sits under the video. The `⋯` button hides or reveals the extra controls (clip, event, loop, keys, download entire video) so the bar stays uncluttered; the choice is remembered.

![Control bar](screenshots/controlbar.png)

### History & archive

Every submission is logged to `localStorage`. A "seen this VOD before" panel lists your past verdicts for repeat VODs, and clicking one re-applies that verdict to the current questions. Press **`a`** for the full archive: a filterable, sortable table of every task you've labelled, with per-question verdicts, match id, links, and JSON/CSV export.

![Labelling history archive](screenshots/archive.png)

### Share & review as a group

`share` exports your labels stamped with a name you choose; `import` merges a teammate's file. Imported verdicts appear with their name (in grey) in the seen-before panel, as blue bands on the timeline, and in a `by` column in the archive — kept in a separate store so your own stats stay clean. A group export bundles everyone's labels with each contributor's name preserved, so a single file can carry the whole team and be relayed onward without losing attribution.

### Privacy

Your reviewer name in the portal header is masked — blurred, clipped to a fixed width so its length doesn't leak, with an eye icon over it — to keep it out of screenshots and streams. Hover to peek, click to pin it open, click again to hide.

## Keyboard shortcuts

Press **`?`** in-app for this list at any time. Question order is 1 aim assist, 2 wall hack, 3 auto bhop, 4 bot.

| key | action | key | action |
| --- | --- | --- | --- |
| space | tap play/pause, hold for 2x | k | play/pause |
| ← → | ±5s | j l | ±10s |
| , . | frame step (pauses) | - = | playback rate down/up |
| f | fullscreen | m | mute |
| c | jump to clip start | v | jump to event moment |
| g | clip loop toggle | d | download / open the full VOD |
| a | history archive | esc | close overlays |
| 1-4 | toggle No / Unsure per question | shift + 1-4 | set Yes |
| z | LEGIT preset (all No) | x | reset (all Unsure) |
| q | AIM preset | h | WH preset |
| r | RAGE preset | | |
| enter | proceed / confirm | backspace | back |

Presets are editable in `CFG.presets` near the top of the script. Fastest clean clip: `z`, `enter`, `enter`.

## Notes

- If the script somehow loads after the page (script manager misconfigured), a red **"clamp active! nuke"** button appears in the bar as a fallback.
- The portal's own console error (`Modal ... addEventListener of null`) is Valve's bug, not the script.
- History lives in `localStorage.vneHistory`, capped at 5000 entries; imported labels live in `localStorage.vneShared`.
