# VACNet Review Enhancer

Userscript for the CS2 VACNet labelling portal (`counter-strike.net/vacnet/clips`). Unlocks full VOD seeking, adds keyboard controls, verdict presets, a clip bar with task info, and local review history.
<br><br>
<b>⚠️ NOTE: This does not let you automate decisions or "farm" labels in order to invite your friends/family/mother/father/sister/brother. It's only real use is to make clicking and decision making easier.</b><br>
<br>🙏 Also please <b>DO NOT</b> use any video clip data after the Valve specified clip range <b>TO INFLUENCE YOUR DECISION.</b><br><i>for example, someone may toggle on halfway through a game but the 10-12 second clip assigned to you may not show that which would mislabel the clip.

<br><br>
<a href="https://raw.githubusercontent.com/KillaBoi/VACNet-Labeling-Portal-Helper/main/vacnet-enhancer.user.js"><img src="https://img.shields.io/badge/INSTALL%20NOW-click%20here-brightgreen?style=for-the-badge" alt="Install now" height="42"></a>
<br><sub>Opens the raw userscript. With <a href="https://www.tampermonkey.net">Tampermonkey</a> or <a href="https://violentmonkey.github.io">Violentmonkey</a> installed it shows an install prompt. If you just see code, the manager is not installed or is not detecting it.</sub>

## Install

1. Install Tampermonkey (or Violentmonkey).
2. Click <b>INSTALL NOW</b> above (or open `vacnet-enhancer.user.js` and press <b>Raw</b>); your script manager shows an install prompt. Fallback: create a new script and paste the file contents.
3. Open the portal. Wide layout kicks in above 1400px window width.<img width="1913" height="934" alt="image" src="https://github.com/user-attachments/assets/929eab23-0811-4768-95c4-9b270f494168" />


## What it does

- **Full VOD seeking**: the portal restricts playback to the assigned ~10s clip with a watchdog interval. The script blocks it at document start, so the native seekbar covers the whole VOD. Orange band = assigned clip, red tick = event moment, green bands = clips of this VOD you labelled before.
- **Clip bar**: dedicated seekbar scoped to the assigned clip, transport buttons, playback rate, task id link, raw VOD link, report bad clip.
- **Layout**: video sized to your window with verdicts on the right, instructions block and footer removed.
- **History**: every submit is logged to localStorage; a "seen this VOD before" panel lists your past verdicts for repeat VODs. Clicking a past entry fills the current questions with that task's verdict.
- **Archive**: `a` (or the history button) opens a full-screen table of every labelled task: time, task link, VOD hash, clip range, per-question verdict, match id (click to copy), raw VOD link. Text + verdict filters, JSON/CSV export. Entries store the full VOD url, view link and match id from v0.2.0 onward; older entries render without links.
- **Out-of-clip warning**: an amber banner appears over the video whenever playback is outside the Valve-assigned clip; click it to jump back to the clip start. Remember: what happens outside the clip must not influence your verdict.
- **Update check**: the script compares its version against this repo every 6 hours and shows a green update pill in the bar when a newer version is available; Tampermonkey also offers one-click updates via `@updateURL`.
- **Share / import**: `share` in the archive exports your labels stamped with a name you choose; `import` merges a mate's file. Their verdicts appear with their name in grey in the seen-before panel (click to fill in), as blue bands on the timeline, and in the archive with a `by` column. Duplicate-safe, and imports are stored separately so your own stats stay clean. If you have imported data, share asks whether to include it: choosing yes exports a `-group` file containing everyone's labels with each contributor's name preserved, so a single file can carry the whole group and be relayed onward without losing attribution.

## Keys

| key | action | key | action |
| --- | --- | --- | --- |
| space | tap play/pause, hold 2x | k | play/pause |
| ← → | ±5s | j l | ±10s |
| , . | frame step (pauses) | - = | rate down/up |
| f | fullscreen | m | mute |
| c | clip start | v | event moment |
| g | clip loop toggle | d | open raw VOD |
| a | history archive | esc | close overlays |
| 1-4 | toggle Not / Uncertain per question | shift+1-4 | label guilty |
| z | LEGIT preset (all Not) | x | reset (all Uncertain) |
| h | WH preset | r | RAGE preset |
| enter | proceed / confirm | backspace | back |
| ? | keymap overlay | | |

Question order: 1 aim assist, 2 wall hack, 3 auto bhop, 4 bot.

Presets are editable in `CFG.presets` at the top of the script. Fastest clean clip: `z`, `enter`, `enter`.

## Notes

- If the script loads after the page (script manager misconfigured), a red "clamp active! nuke" button appears in the bar as a fallback.
- The portal's own console error (`Modal ... addEventListener of null`) is Valve's bug, not the script.
- History lives in `localStorage.vneHistory`, capped at 5000 entries.
<img width="1893" height="927" alt="image" src="https://github.com/user-attachments/assets/f40964be-a5a8-410c-ae5c-fb335f1ffc7b" />
