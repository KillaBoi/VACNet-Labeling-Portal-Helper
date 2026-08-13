# VACNet Review Enhancer

Userscript for the CS2 VACNet labelling portal (`counter-strike.net/vacnet/clips`). Unlocks full VOD seeking, adds keyboard controls, verdict presets, a clip bar with task info, and local review history.
<br><br>
<b>⚠️ NOTE: This does not let you automate decisions or "farm" labels in order to invite your friends/family/mother/father/sister/brother. It's only real use is to make clicking and decision making easier. Also please DO NOT use any video clip data after the Valve specified clip range TO INFLUENCE YOUR DECISION. <i>for example, someone may toggle on halfway through a game but the 10-12 second clip assigned to you may not show that which would mislabel the clip.

## Install

1. Install Tampermonkey (or Violentmonkey).
2. Dashboard → Utilities → import, click into the code and press 'raw' on GitHub or create a new script and paste the contents of`vacnet-enhancer.user.js`.
3. Open the portal. Wide layout kicks in above 1400px window width.<img width="1913" height="934" alt="image" src="https://github.com/user-attachments/assets/929eab23-0811-4768-95c4-9b270f494168" />


## What it does

- **Full VOD seeking**: the portal restricts playback to the assigned ~10s clip with a watchdog interval. The script blocks it at document start, so the native seekbar covers the whole VOD. Orange band = assigned clip, red tick = event moment, green bands = clips of this VOD you labelled before.
- **Clip bar**: dedicated seekbar scoped to the assigned clip, transport buttons, playback rate, task id link, raw VOD link, report bad clip.
- **Layout**: video sized to your window with verdicts on the right, instructions block and footer removed.
- **History**: every submit is logged to localStorage; a "seen this VOD before" panel lists your past verdicts for repeat VODs.
- **Archive**: `a` (or the history button) opens a full-screen table of every labelled task: time, task link, VOD hash, clip range, verdict, match id (click to copy), raw VOD link. Text + verdict filters, JSON/CSV export. Entries store the full VOD url, view link and match id from v0.2.0 onward; older entries render without links.

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
