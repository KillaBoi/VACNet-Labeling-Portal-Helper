// ==UserScript==
// @name         VACNet Review Enhancer
// @namespace    https://counerstri.ke
// @version      0.6.3
// @description  full vod seeking, keyboard controls, verdict presets, clip bar, task info, history for the CS2 VACNet labelling portal
// @author       killa
// @homepageURL  https://github.com/KillaBoi/VACNet-Labeling-Portal-Helper
// @updateURL    https://raw.githubusercontent.com/KillaBoi/VACNet-Labeling-Portal-Helper/main/vacnet-enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/KillaBoi/VACNet-Labeling-Portal-Helper/main/vacnet-enhancer.user.js
// @match        https://www.counter-strike.net/vacnet*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

/* ---------------------------------------------------------------------------
 *  READING THIS AS PLAIN TEXT?
 *  Then Tampermonkey / Violentmonkey is NOT installed, or it did not detect
 *  this script. A working script manager shows its install screen instead of
 *  showing this code. Install one from https://www.tampermonkey.net or
 *  https://violentmonkey.github.io , then reopen this .user.js to install.
 * ------------------------------------------------------------------------- */

(function () {
	'use strict';
	if (window.__vne) return; // no double inject
	window.__vne = true;

	// ---------------- config ----------------
	const CFG = {
		seekSmall: 5,        // arrows
		seekBig: 10,         // j/l
		holdRate: 2,         // space hold
		rateStep: 0.25,      // - / =
		rateMin: 0.25,
		rateMax: 4,
		fps: 60,             // measured on portal vods
		historyMax: 5000,
		// preset name -> [aimassist, wallhack, autobhop, bot], values: positive|skip|negative
		presets: {
			LEGIT: ['negative', 'negative', 'negative', 'negative'],
			WH:    ['negative', 'positive', 'negative', 'negative'],
			RAGE:  ['positive', 'positive', 'positive', 'negative'],
		},
	};
	const QUESTIONS = ['aimassist', 'wallhack', 'autobhop', 'bot'];
	const LS_HISTORY = 'vneHistory';
	const LS_SHARED = 'vneShared';
	const LS_NAME = 'vneName';
	const LS_UPDATE = 'vneUpdate';
	const VERSION = (typeof GM_info !== 'undefined' && GM_info.script?.version) || '0.6.3'; // fallback in sync with @version
	const UPDATE_RAW = 'https://raw.githubusercontent.com/KillaBoi/VACNet-Labeling-Portal-Helper/main/vacnet-enhancer.user.js';
	const UPDATE_PAGE = 'https://github.com/KillaBoi/VACNet-Labeling-Portal-Helper';

	// ---------------- clamp block (document-start) ----------------
	// portal clamps playback with a 100ms setInterval, block it before it starts
	let clampBlocked = 0;
	const origSetInterval = window.setInterval;
	window.setInterval = function (fn, delay, ...rest) {
		try {
			if (typeof fn === 'function' && String(fn).includes('curTime >= endTime')) {
				clampBlocked++;
				return origSetInterval(function () {}, 1 << 30); // dummy id, never fires
			}
		} catch (e) { /* toString can throw on proxies, ignore */ }
		return origSetInterval(fn, delay, ...rest);
	};

	// ---------------- helpers ----------------
	const $ = (sel, root) => (root || document).querySelector(sel);
	const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
	const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
	const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
	const fmt = s => {
		if (!isFinite(s)) return '0:00';
		const m = Math.floor(s / 60), sec = s - m * 60;
		return m + ':' + sec.toFixed(1).padStart(4, '0');
	};
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

	// ---------------- state ----------------
	let player = null;          // videojs player
	let vid = null;             // raw <video>
	let clip = { start: 0, end: 0, event: 0, ok: false };
	let task = { id: null, viewUrl: null, app: null, matchId: null };
	let clipLoop = false;
	let holdTimer = null, holdEngaged = false, preHoldRate = 1;
	let ui = {};

	// ---------------- init ----------------
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}

	function boot() {
		if (!$('#video') || !$('#submitverdictform')) return; // not the review page
		parseClipMeta();
		parseTaskMeta();
		waitForPlayer();
	}

	function parseClipMeta() {
		for (const s of $$('script:not([src])')) {
			const t = s.textContent;
			const m1 = t.match(/const startTime = ([\d.]+)/);
			if (!m1) continue;
			const m2 = t.match(/startTime \+ ([\d.]+)/);
			const m3 = t.match(/const eventTime = ([\d.]+)/);
			clip.start = parseFloat(m1[1]);
			clip.end = m2 ? clip.start + parseFloat(m2[1]) : clip.start + 12;
			clip.event = m3 ? parseFloat(m3[1]) : clip.start;
			clip.ok = true;
			return;
		}
		console.warn('[vne] clip constants not found, markers disabled');
	}

	function parseTaskMeta() {
		task.id = $('#submitverdictform input[name="verdict_task"]')?.value || null;
		const link = $('#detailsModalContent a[href*="/vacnet/view"]');
		task.viewUrl = link ? link.href : null;
		const cells = $$('#detailsModalContent .detailstable td');
		for (let i = 0; i < cells.length - 1; i += 2) {
			const k = cells[i].textContent.trim();
			if (k === 'App') task.app = cells[i + 1].textContent.trim();
			if (k === 'Match ID') task.matchId = cells[i + 1].textContent.trim();
		}
	}

	function waitForPlayer() {
		if (window.videojs && window.videojs.getPlayer && window.videojs.getPlayer('video')) {
			player = window.videojs.getPlayer('video');
		} else if (window.videojs && $('#video')) {
			try { player = window.videojs('video'); } catch (e) {}
		}
		if (!player) return void setTimeout(waitForPlayer, 100);
		player.ready(() => {
			vid = $('#video video') || $('video');
			buildUI();
			hookKeys();
			hookSubmit();
			if (!clampBlocked) console.warn('[vne] clamp interval was not intercepted, use the nuke button');
		});
	}

	// ---------------- ui ----------------
	function buildUI() {
		injectCSS();
		buildBar();
		buildOutClipBanner();
		buildProgressOverlay();
		buildPresetRow();
		buildHistoryPanel();
		buildArchive();
		buildKeymapOverlay();
		buildVersionBadge();
		hookRelabel();
		player.on('timeupdate', renderTick);
		origSetInterval(renderTick, 250); // catch paused-state seeks
		checkUpdate();
	}

	function verGt(a, b) {
		const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
		for (let i = 0; i < 3; i++) {
			if ((pa[i] || 0) > (pb[i] || 0)) return true;
			if ((pa[i] || 0) < (pb[i] || 0)) return false;
		}
		return false;
	}
	function markUpdateAvailable(v) {
		const el = $('#vne-ver');
		if (!el) return;
		el.textContent = `⬆ update available · v${v}`;
		el.classList.add('vne-ver-update');
		el.href = UPDATE_RAW; // raw user.js, opening it prompts tampermonkey to install
		el.title = `you are on v${VERSION}, v${v} is on github. click to install, or use tampermonkey check for updates`;
	}
	function checkUpdate() {
		// one check per page load / new case, cached value shows instantly then the fetch refreshes it
		const cached = lsGet(LS_UPDATE, { v: '' });
		if (cached.v && verGt(cached.v, VERSION)) markUpdateAvailable(cached.v);
		fetch(UPDATE_RAW, { cache: 'no-store' })
			.then(r => r.ok ? r.text() : '')
			.then(t => {
				const v = (t.match(/@version\s+([\d.]+)/) || [])[1] || '';
				if (v) lsSet(LS_UPDATE, { v });
				if (v && verGt(v, VERSION)) markUpdateAvailable(v);
			})
			.catch(() => {}); // csp/network fail, manager @updateURL still covers updates
	}

	function buildVersionBadge() {
		const a = document.createElement('a');
		a.id = 'vne-ver';
		a.href = UPDATE_PAGE; a.target = '_blank';
		a.textContent = 'VACNet Review Enhancer v' + VERSION;
		document.body.appendChild(a);
	}

	function buildOutClipBanner() {
		if (!clip.ok) return;
		const b = document.createElement('div');
		b.id = 'vne-outclip';
		b.textContent = '⚠ outside the assigned clip · click to jump back';
		b.title = 'you are watching the rest of the vod, not the clip valve assigned';
		b.onclick = () => seekTo(clip.start);
		($('.video-js') || $('.videocontainer')).appendChild(b);
		ui.outclip = b;
	}

	function injectCSS() {
		const css = `
		/* layout: video left, verdicts right */
		@media (min-width: 1400px) {
			.flex-row-wrap { flex: 1 1 auto; width: auto !important; max-width: none !important; margin: 0 !important; flex-wrap: nowrap !important; align-items: flex-start !important; gap: 12px; justify-content: center; }
			.video-column { flex: 0 0 auto !important; width: min(100% - 620px, (100vh - 200px) * 16 / 9) !important; max-width: none !important; }
			.verdict-column { width: 600px !important; min-width: 600px; max-width: 600px; position: sticky; top: 8px; }
			.verdicts-container { height: auto !important; min-height: 0 !important; }
			.footer-container { display: none !important; } /* overlaps bar, bad clip button replaces it */
		}
		.videocontainer .video-js, .videocontainer video#video, #video { width: 100% !important; height: auto !important; aspect-ratio: 16 / 9; }
		.videocontainer { width: 100% !important; }

		#vne-bar { background: #15181d; border: 1px solid #2a2f38; border-top: none; padding: 6px 10px 8px; font: 12px/1.4 "Motiva Sans", Arial, sans-serif; color: #c8cdd4; user-select: none; }
		#vne-clipbar { position: relative; height: 14px; background: #262b33; border-radius: 3px; cursor: pointer; margin-bottom: 6px; }
		#vne-clipbar-fill { position: absolute; top: 0; left: 0; height: 100%; background: #e8a33d55; border-radius: 3px; pointer-events: none; }
		#vne-clipbar-head { position: absolute; top: -2px; width: 3px; height: 18px; background: #e8a33d; border-radius: 2px; pointer-events: none; }
		#vne-clipbar-event { position: absolute; top: 2px; width: 2px; height: 10px; background: #ff5252; pointer-events: none; }
		#vne-clipbar .vne-label { position: absolute; right: 4px; top: 0; font-size: 10px; color: #8a919c; pointer-events: none; }
		#vne-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
		.vne-btn { background: #262b33; color: #c8cdd4; border: 1px solid #343b46; border-radius: 3px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
		.vne-btn:hover { background: #343b46; color: #fff; }
		.vne-btn.vne-on { background: #e8a33d; color: #15181d; border-color: #e8a33d; }
		#vne-time { margin-left: auto; color: #8a919c; white-space: nowrap; }
		#vne-time b { color: #e8a33d; font-weight: 600; }
		#vne-task { color: #8a919c; white-space: nowrap; }
		#vne-task a { color: #6db3e8; text-decoration: none; }
		#vne-task a:hover { text-decoration: underline; }
		#vne-match { cursor: pointer; border-bottom: 1px dotted #8a919c; }
		#vne-nuke { background: #7a2b2b; border-color: #a03535; color: #ffdede; }
		#vne-outclip { display: none; position: absolute; top: 0; left: 0; right: 0; z-index: 10; background: #e8a33dd9; color: #15181d; font: 700 13px/1 "Motiva Sans", Arial, sans-serif; text-align: center; padding: 6px 0; cursor: pointer; user-select: none; }
		#vne-outclip.vne-show { display: block; }
		#vne-ver { position: fixed; right: 8px; bottom: 6px; z-index: 100000; font: 11px/1 monospace; color: #566070; text-decoration: none; user-select: none; }
		#vne-ver:hover { color: #8a919c; }
		#vne-ver.vne-ver-update { color: #6dd36d; font-weight: 700; }
		#vne-ver.vne-ver-update:hover { color: #8ff08f; }

		/* clip band on native full progress bar */
		.vjs-progress-holder { overflow: visible; }
		.vne-band { position: absolute; top: 0; height: 100%; background: #e8a33d66; pointer-events: none; z-index: 1; }
		.vne-band.vne-hist { background: #4caf5044; }
		.vne-band.vne-shared { background: #6db3e844; }
		.vne-tick { position: absolute; top: -3px; width: 2px; height: calc(100% + 6px); background: #ff5252; pointer-events: none; z-index: 2; }
		.vne-tick.vne-hist { background: #4caf50; }

		/* presets */
		#vne-presets { display: flex; gap: 8px; margin: 0 0 10px; }
		#vne-presets .vne-btn { flex: 1; text-align: center; font-weight: 700; padding: 6px 0; }
		#vne-preset-legit { background: #2e7d32; border-color: #2e7d32; color: #eaffea; }
		#vne-preset-wh { background: #c98a1b; border-color: #c98a1b; color: #fff7e5; }
		#vne-preset-rage { background: #b03030; border-color: #b03030; color: #ffecec; }
		#vne-presets .vne-btn:hover { filter: brightness(1.2); }

		/* history */
		#vne-history { margin-top: 10px; font: 11px/1.5 "Motiva Sans", Arial, sans-serif; color: #8a919c; }
		#vne-history h4 { margin: 0 0 4px; font-size: 12px; color: #e8a33d; }
		#vne-history .vne-hrow { display: flex; gap: 8px; justify-content: space-between; border-bottom: 1px solid #262b33; padding: 1px 2px; }
		#vne-history .vne-hrow.vne-apply { cursor: pointer; }
		#vne-history .vne-hrow.vne-apply:hover { background: #262b33; }
		#vne-history .vne-hlabels { color: #c8cdd4; }
		#vne-history .vne-hlabels.vne-clean { color: #4caf50; }
		#vne-history .vne-hlabels.vne-guilty { color: #ff5252; }

		/* archive overlay */
		#vne-arch { display: none; position: fixed; inset: 0; z-index: 99998; background: #0f1216f2; overflow-y: auto; padding: 24px 40px; font: 13px/1.5 "Motiva Sans", Arial, sans-serif; color: #c8cdd4; }
		#vne-arch.vne-show { display: block; }
		#vne-arch-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
		#vne-arch-top h2 { margin: 0 12px 0 0; font-size: 18px; color: #e8a33d; }
		#vne-arch-close { margin-left: auto; font-size: 16px; }
		#vne-arch-q { background: #1b2026; border: 1px solid #343b46; color: #c8cdd4; padding: 4px 10px; border-radius: 3px; width: 240px; outline: none; }
		#vne-arch-stats { color: #8a919c; margin-bottom: 10px; }
		#vne-arch table { width: 100%; border-collapse: collapse; }
		#vne-arch th { text-align: left; padding: 4px 10px; color: #8a919c; font-weight: 600; border-bottom: 1px solid #343b46; position: sticky; top: -24px; background: #0f1216; }
		#vne-arch td { text-align: left; padding: 3px 10px; border-bottom: 1px solid #1e232a; white-space: nowrap; }
		#vne-arch td a { color: #6db3e8; text-decoration: none; }
		#vne-arch td a:hover { text-decoration: underline; }
		#vne-arch .vne-clean { color: #4caf50; }
		#vne-arch .vne-guilty { color: #ff5252; }
		#vne-arch .vne-mono { font-family: monospace; font-size: 12px; color: #8a919c; }
		#vne-arch .vne-skip { color: #8a919c; }
		#vne-arch .vne-copy { cursor: pointer; border-bottom: 1px dotted #8a919c; }
		.vne-by { color: #8a919c; font-style: italic; }
		.vne-btn.vne-filter-on { background: #e8a33d; color: #15181d; border-color: #e8a33d; }

		/* keymap overlay */
		#vne-keymap { display: none; position: fixed; z-index: 99999; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #15181de8; border: 1px solid #343b46; border-radius: 6px; padding: 16px 22px; color: #c8cdd4; font: 12px/1.7 monospace; white-space: pre; }
		#vne-keymap.vne-show { display: block; }
		#vne-keymap b { color: #e8a33d; }

		.top-section { display: none !important; }
		`;
		const st = document.createElement('style');
		st.textContent = css;
		document.head.appendChild(st);
	}

	function buildBar() {
		const bar = document.createElement('div');
		bar.id = 'vne-bar';
		const vodUrl = vid?.currentSrc || '';
		const taskHtml = task.id
			? `task ${task.viewUrl ? `<a href="${task.viewUrl}" target="_blank">#${task.id}</a>` : '#' + task.id}${task.matchId && task.matchId !== 'none' ? ` · match <span id="vne-match" title="click to copy">${task.matchId}</span>` : ''}`
			: 'task ?';
		bar.innerHTML = `
			<div id="vne-clipbar" title="clip timeline, click to seek">
				<div id="vne-clipbar-fill"></div>
				<div id="vne-clipbar-event"></div>
				<div id="vne-clipbar-head"></div>
				<span class="vne-label">CLIP</span>
			</div>
			<div id="vne-row">
				<button class="vne-btn" id="vne-play" title="space / k">▶</button>
				<button class="vne-btn" id="vne-fb" title=", frame back">⏮</button>
				<button class="vne-btn" id="vne-ff" title=". frame fwd">⏭</button>
				<button class="vne-btn" id="vne-rate" title="- / = rate, hold space 2x">1x</button>
				<button class="vne-btn" id="vne-clipstart" title="c">clip</button>
				<button class="vne-btn" id="vne-event" title="v">event</button>
				<button class="vne-btn" id="vne-loop" title="g, restore original clip looping">loop</button>
				<button class="vne-btn" id="vne-fs" title="f">⛶</button>
				<a class="vne-btn" id="vne-vod" href="${vodUrl}" target="_blank" title="d, raw vod webm">vod</a>
				<button class="vne-btn" id="vne-keys" title="?">keys</button>
				<button class="vne-btn" id="vne-bad" title="report bad clip, submits immediately">bad clip</button>
				<button class="vne-btn" id="vne-hist-btn" title="a, labelling history">history</button>
				<span id="vne-task">${taskHtml}</span>
				<span id="vne-time"></span>
			</div>`;
		$('.videocontainer').appendChild(bar);

		ui.play = $('#vne-play'); ui.rate = $('#vne-rate'); ui.loop = $('#vne-loop');
		ui.time = $('#vne-time'); ui.clipbar = $('#vne-clipbar');
		ui.clipFill = $('#vne-clipbar-fill'); ui.clipHead = $('#vne-clipbar-head'); ui.clipEvent = $('#vne-clipbar-event');

		ui.play.onclick = togglePlay;
		$('#vne-fb').onclick = () => frameStep(-1);
		$('#vne-ff').onclick = () => frameStep(1);
		ui.rate.onclick = () => setRate(player.playbackRate() >= CFG.rateMax ? 1 : player.playbackRate() + CFG.rateStep);
		$('#vne-clipstart').onclick = () => seekTo(clip.start);
		$('#vne-event').onclick = () => seekTo(clip.event - 2); // land just before the moment
		ui.loop.onclick = toggleLoop;
		$('#vne-fs').onclick = toggleFullscreen;
		$('#vne-keys').onclick = toggleKeymap;
		$('#vne-bad').onclick = () => { if (window.confirm('report bad clip? submits immediately')) window.ReportBadClip(); };
		$('#vne-hist-btn').onclick = toggleArchive;
		const mEl = $('#vne-match');
		if (mEl) mEl.onclick = () => { navigator.clipboard.writeText(task.matchId); mEl.style.color = '#4caf50'; setTimeout(() => mEl.style.color = '', 600); };

		if (!clampBlocked) {
			const nuke = document.createElement('button');
			nuke.className = 'vne-btn'; nuke.id = 'vne-nuke';
			nuke.textContent = 'clamp active! nuke';
			nuke.title = 'script loaded late, clear all page intervals to kill the clip clamp';
			nuke.onclick = () => { for (let i = 1; i < 100000; i++) window.clearInterval(i); nuke.remove(); };
			$('#vne-row').insertBefore(nuke, ui.time);
		}

		// clip bar seek: click + drag
		const clipSeek = e => {
			if (!clip.ok) return;
			const r = ui.clipbar.getBoundingClientRect();
			const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
			seekTo(clip.start + frac * (clip.end - clip.start));
		};
		let dragging = false;
		ui.clipbar.addEventListener('mousedown', e => { dragging = true; clipSeek(e); });
		document.addEventListener('mousemove', e => { if (dragging) clipSeek(e); });
		document.addEventListener('mouseup', () => { dragging = false; });
	}

	function buildProgressOverlay() {
		const holder = $('.vjs-progress-holder');
		if (!holder || !clip.ok) return;
		const dur = player.duration() || vid.duration;
		if (!dur) return void player.one('loadedmetadata', buildProgressOverlay);

		const band = document.createElement('div');
		band.className = 'vne-band';
		band.style.left = (clip.start / dur * 100) + '%';
		band.style.width = ((clip.end - clip.start) / dur * 100) + '%';
		holder.appendChild(band);

		const tick = document.createElement('div');
		tick.className = 'vne-tick';
		tick.style.left = (clip.event / dur * 100) + '%';
		holder.appendChild(tick);

		// green bands ours, blue bands imported mates
		const vodKey = vodId();
		for (const h of history().filter(h => h.vod === vodKey)) {
			const hb = document.createElement('div');
			hb.className = 'vne-band vne-hist';
			hb.style.left = (h.start / dur * 100) + '%';
			hb.style.width = ((h.end - h.start) / dur * 100) + '%';
			holder.appendChild(hb);
		}
		for (const h of shared().filter(h => h.vod === vodKey)) {
			const hb = document.createElement('div');
			hb.className = 'vne-band vne-shared';
			hb.style.left = (h.start / dur * 100) + '%';
			hb.style.width = ((h.end - h.start) / dur * 100) + '%';
			holder.appendChild(hb);
		}
	}

	function buildPresetRow() {
		const row = document.createElement('div');
		row.id = 'vne-presets';
		row.innerHTML = `
			<button class="vne-btn" id="vne-preset-legit" title="z, all Not">LEGIT</button>
			<button class="vne-btn" id="vne-preset-wh" title="h">WH</button>
			<button class="vne-btn" id="vne-preset-rage" title="r">RAGE</button>
			<button class="vne-btn" id="vne-preset-reset" title="x, all Uncertain">RESET</button>`;
		const target = $('.verdicts-container');
		target.parentNode.insertBefore(row, target);
		$('#vne-preset-legit').onclick = () => applyPreset('LEGIT');
		$('#vne-preset-wh').onclick = () => applyPreset('WH');
		$('#vne-preset-rage').onclick = () => applyPreset('RAGE');
		$('#vne-preset-reset').onclick = () => QUESTIONS.forEach(q => setVerdict(q, 'skip'));
	}

	function buildHistoryPanel() {
		const vodKey = vodId();
		const seen = history().filter(h => h.vod === vodKey)
			.concat(shared().filter(h => h.vod === vodKey))
			.sort((a, b) => (b.ts || 0) - (a.ts || 0));
		const box = document.createElement('div');
		box.id = 'vne-history';
		if (seen.length) {
			const rows = seen.slice(0, 12).map((h, i) => {
				const s = labelSummary(h.labels);
				const ago = Math.round((Date.now() - h.ts) / 3600000);
				const canApply = (h.labels || []).some(l => /^(guilty|innocent|skip)_/.test(l));
				return `<div class="vne-hrow${canApply ? ' vne-apply' : ''}" data-i="${i}"${canApply ? ' title="click to fill in this verdict"' : ''}><span class="vne-hlabels ${s.cls}">${s.txt}</span><span>${fmt(h.start)} → ${fmt(h.end)}</span><span>${ago < 1 ? '<1h' : ago + 'h'} ago · #${h.task}${h.by ? ` · <span class="vne-by">${h.by}</span>` : ''}</span></div>`;
			}).join('');
			box.innerHTML = `<h4>Seen this VOD ${seen.length} time${seen.length > 1 ? 's' : ''} before</h4>${rows}`;
			for (const row of box.querySelectorAll('.vne-hrow.vne-apply')) {
				row.onclick = () => {
					applyLabels(seen[+row.dataset.i].labels);
					row.style.background = '#4caf5033';
					setTimeout(() => row.style.background = '', 400);
				};
			}
		} else {
			const total = history().length;
			box.innerHTML = `<h4>New VOD</h4><div>${total} clips in local history</div>`;
		}
		$('#submitverdictform').parentNode.appendChild(box);
	}

	let archFilter = { q: '', kind: 'all' };
	function buildArchive() {
		const ov = document.createElement('div');
		ov.id = 'vne-arch';
		ov.innerHTML = `
			<div id="vne-arch-top">
				<h2>Labelling History</h2>
				<input id="vne-arch-q" type="text" placeholder="filter task / vod / match">
				<button class="vne-btn vne-filter-on" data-kind="all">all</button>
				<button class="vne-btn" data-kind="clean">clean</button>
				<button class="vne-btn" data-kind="uncertain">uncertain</button>
				<button class="vne-btn" data-kind="guilty">guilty</button>
				<button class="vne-btn" id="vne-arch-json">export json</button>
				<button class="vne-btn" id="vne-arch-csv">export csv</button>
				<button class="vne-btn" id="vne-arch-share" title="export your labels with your name, for a mate to import">share</button>
				<button class="vne-btn" id="vne-arch-import" title="import a mate's share file">import</button>
				<input type="file" id="vne-import-file" accept=".json,application/json" style="display:none">
				<button class="vne-btn" id="vne-arch-close" title="esc">✕</button>
			</div>
			<div id="vne-arch-stats"></div>
			<div id="vne-arch-body"></div>`;
		document.body.appendChild(ov);
		$('#vne-arch-close').onclick = toggleArchive;
		$('#vne-arch-q').oninput = e => { archFilter.q = e.target.value.trim().toLowerCase(); renderArchive(); };
		for (const b of $$('#vne-arch-top [data-kind]')) {
			b.onclick = () => {
				archFilter.kind = b.dataset.kind;
				$$('#vne-arch-top [data-kind]').forEach(x => x.classList.toggle('vne-filter-on', x === b));
				renderArchive();
			};
		}
		$('#vne-arch-share').onclick = exportShare;
		$('#vne-arch-import').onclick = () => $('#vne-import-file').click();
		$('#vne-import-file').onchange = e => { if (e.target.files[0]) importShare(e.target.files[0]); e.target.value = ''; };
		$('#vne-arch-json').onclick = () => dl('vacnet-history.json', JSON.stringify(history(), null, 1), 'application/json');
		$('#vne-arch-csv').onclick = () => {
			const esc = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
			const head = 'ts,task,vod,start,end,event,verdict,labels,match,view,vodUrl';
			const rows = history().map(h => [
				new Date(h.ts).toISOString(), h.task, h.vod, h.start, h.end, h.event,
				labelSummary(h.labels).txt, (h.labels || []).join('|'), h.match || '', h.view || '', h.vodUrl || '',
			].map(esc).join(','));
			dl('vacnet-history.csv', [head, ...rows].join('\n'), 'text/csv');
		};
	}

	function dl(name, text, mime) {
		const u = URL.createObjectURL(new Blob([text], { type: mime }));
		const a = document.createElement('a');
		a.href = u; a.download = name; a.click();
		setTimeout(() => URL.revokeObjectURL(u), 2000);
	}

	function renderArchive() {
		const all = history().concat(shared()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
		const kindOf = h => labelSummary(h.labels).txt === 'clean' ? 'clean'
			: labelSummary(h.labels).txt === 'uncertain' ? 'uncertain'
			: (h.labels || []).some(l => l.startsWith('guilty')) ? 'guilty' : 'other';
		const list = all.filter(h => {
			if (archFilter.kind !== 'all' && kindOf(h) !== archFilter.kind) return false;
			if (!archFilter.q) return true;
			return [h.task, h.vod, h.match, h.by].some(v => String(v || '').toLowerCase().includes(archFilter.q));
		});
		const counts = { clean: 0, uncertain: 0, guilty: 0, other: 0 };
		for (const h of all) counts[kindOf(h)]++;
		const imported = shared().length;
		$('#vne-arch-stats').textContent =
			`${all.length - imported} labelled · ${counts.clean} clean · ${counts.uncertain} uncertain · ${counts.guilty} guilty` +
			(counts.other ? ` · ${counts.other} other` : '') +
			(imported ? ` · ${imported} imported` : '') +
			(list.length !== all.length ? ` · showing ${list.length}` : '');
		const pad = n => String(n).padStart(2, '0');
		const when = ts => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
		const CAP = 500;
		const rows = list.slice(0, CAP).map(h => {
			return `<tr>
				<td>${when(h.ts)}</td>
				<td>${h.view ? `<a href="${h.view}" target="_blank">#${h.task}</a>` : '#' + (h.task || '?')}</td>
				<td class="vne-mono">${h.vod || ''}</td>
				<td>${fmt(h.start)} → ${fmt(h.end)}</td>
				<td>${labelDetail(h.labels)}</td>
				<td class="vne-by">${h.by || ''}</td>
				<td>${h.match ? `<span class="vne-copy vne-mono" data-copy="${h.match}" title="click to copy">${h.match}</span>` : ''}</td>
				<td>${h.vodUrl ? `<a href="${h.vodUrl}" target="_blank">vod</a>` : ''}</td>
			</tr>`;
		}).join('');
		$('#vne-arch-body').innerHTML = list.length
			? `<table><tr><th>when</th><th>task</th><th>vod</th><th>clip</th><th>verdict</th><th>by</th><th>match</th><th>links</th></tr>${rows}</table>` +
				(list.length > CAP ? `<p>showing latest ${CAP} of ${list.length}, filter or export for the rest</p>` : '')
			: '<p>nothing yet</p>';
		for (const el of $$('#vne-arch .vne-copy')) {
			el.onclick = () => { navigator.clipboard.writeText(el.dataset.copy); el.style.color = '#4caf50'; setTimeout(() => el.style.color = '', 600); };
		}
	}

	function toggleArchive() {
		const ov = $('#vne-arch');
		const show = !ov.classList.contains('vne-show');
		ov.classList.toggle('vne-show', show);
		if (show) renderArchive();
	}

	function buildKeymapOverlay() {
		const km = document.createElement('div');
		km.id = 'vne-keymap';
		km.innerHTML =
`<b>player</b>
space      tap play/pause, hold 2x
k          play/pause     m  mute
← →        ±${CFG.seekSmall}s            j l  ±${CFG.seekBig}s
, .        frame step (pauses)
- =        rate down/up   f  fullscreen
c          clip start     v  event
g          clip loop      d  open vod
a          history        esc  close overlays

<b>verdicts</b> (1 aim, 2 wh, 3 bhop, 4 bot)
1-4        toggle No / Unsure
shift+1-4  Yes
z LEGIT    h WH    r RAGE    x reset
enter      proceed / confirm
backspace  back
?          this help`;
		document.body.appendChild(km);
	}

	// ---------------- render ----------------
	function renderTick() {
		if (!vid) return;
		const t = vid.currentTime;
		ui.play.textContent = vid.paused ? '▶' : '⏸';
		ui.rate.textContent = player.playbackRate() + 'x';
		if (clip.ok) {
			const len = clip.end - clip.start;
			const frac = clamp((t - clip.start) / len, 0, 1);
			ui.clipFill.style.width = (frac * 100) + '%';
			ui.clipHead.style.left = `calc(${frac * 100}% - 1px)`;
			ui.clipEvent.style.left = (clamp((clip.event - clip.start) / len, 0, 1) * 100) + '%';
			const inClip = t >= clip.start - 0.05 && t <= clip.end + 0.001;
			ui.time.innerHTML = `${fmt(t)} / ${fmt(vid.duration)} · clip <b>${inClip ? fmt(clamp(t - clip.start, 0, len)) : '-'}</b> / ${fmt(len)}`;
			if (ui.outclip) ui.outclip.classList.toggle('vne-show', !inClip);
			if (clipLoop && t >= clip.end) seekTo(clip.start);
		} else {
			ui.time.textContent = `${fmt(t)} / ${fmt(vid.duration)}`;
		}
	}

	// ---------------- player actions ----------------
	function seekTo(t) { player.currentTime(clamp(t, 0, vid.duration || 1e9)); }
	function seekBy(d) { seekTo(vid.currentTime + d); }
	function togglePlay() { vid.paused ? player.play() : player.pause(); }
	function setRate(r) { player.playbackRate(clamp(Math.round(r * 100) / 100, CFG.rateMin, CFG.rateMax)); renderTick(); }
	function frameStep(dir) { player.pause(); seekBy(dir / CFG.fps); }
	function toggleFullscreen() { player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen(); }
	function toggleLoop() {
		clipLoop = !clipLoop;
		ui.loop.classList.toggle('vne-on', clipLoop);
	}

	// ---------------- verdict actions ----------------
	function setVerdict(q, val) {
		const el = document.getElementById(q + '_' + val);
		if (el) el.checked = true;
	}
	function getVerdict(q) {
		return document.querySelector(`input[name="${q}"]:checked`)?.value || 'skip';
	}
	function applyPreset(name) {
		const p = CFG.presets[name];
		if (!p) return;
		QUESTIONS.forEach((q, i) => setVerdict(q, p[i]));
	}
	// rename verdict buttons to Yes / Unsure / No, portal regenerates them so observe + reapply
	// color: Yes red, Unsure amber, No green
	const VTEXT = { positive: 'Yes', skip: 'Unsure', negative: 'No' };
	const VCOLOR = { positive: '#ff5252', skip: '#e8a33d', negative: '#4caf50' };
	function verdictHtml(kind) {
		return `<b style="color:${VCOLOR[kind]}">${VTEXT[kind]}</b>`;
	}
	function relabelVerdicts() {
		for (const btn of $$('.verdictbutton')) {
			const label = btn.querySelector('label');
			if (!label) continue;
			const kind = btn.classList.contains('positive') ? 'positive'
				: btn.classList.contains('negative') ? 'negative' : 'skip';
			const html = verdictHtml(kind);
			if (label.innerHTML !== html) label.innerHTML = html;
		}
		// confirm screen summary, dataset guard so our own No is not reparsed as positive
		for (const p of $$('.verdictbuttonsverdictlabel')) {
			if (p.dataset.vne) continue;
			const txt = p.textContent;
			const kind = /uncertain/i.test(txt) ? 'skip' : /\bnot\b/i.test(txt) ? 'negative' : 'positive';
			p.dataset.vne = '1';
			p.innerHTML = '&nbsp;' + verdictHtml(kind);
		}
	}
	function hookRelabel() {
		const col = $('.verdicts-container') || $('.verdict-column');
		if (!col) return;
		relabelVerdicts();
		const obs = new MutationObserver(() => {
			obs.disconnect();
			try { relabelVerdicts(); } finally { obs.observe(col, { childList: true, subtree: true }); }
		});
		obs.observe(col, { childList: true, subtree: true });
	}
	function applyLabels(labels) {
		$('#backbutton')?.click(); // back to labeling mode if on confirm screen
		for (const l of labels || []) {
			const m = l.match(/^(guilty|innocent|skip)_(.+)$/);
			if (!m || !QUESTIONS.includes(m[2])) continue;
			setVerdict(m[2], m[1] === 'guilty' ? 'positive' : m[1] === 'innocent' ? 'negative' : 'skip');
		}
	}

	// ---------------- keyboard ----------------
	function hookKeys() {
		document.addEventListener('keydown', e => {
			const a = document.activeElement;
			if (a && (a.tagName === 'INPUT' && a.type === 'text' || a.tagName === 'TEXTAREA')) return;
			if (e.ctrlKey || e.altKey || e.metaKey) return;

			const k = e.key;
			let handled = true;
			switch (k) {
				case ' ':
					if (e.repeat) break;
					// hold = 2x, tap = play/pause (decided on keyup)
					holdEngaged = false;
					preHoldRate = player.playbackRate();
					holdTimer = setTimeout(() => { holdEngaged = true; player.playbackRate(CFG.holdRate); if (vid.paused) player.play(); renderTick(); }, 220);
					break;
				case 'k': case 'K': togglePlay(); break;
				case 'ArrowLeft': seekBy(-CFG.seekSmall); break;
				case 'ArrowRight': seekBy(CFG.seekSmall); break;
				case 'j': case 'J': seekBy(-CFG.seekBig); break;
				case 'l': case 'L': seekBy(CFG.seekBig); break;
				case ',': frameStep(-1); break;
				case '.': frameStep(1); break;
				case '-': case '_': setRate(player.playbackRate() - CFG.rateStep); break;
				case '=': case '+': setRate(player.playbackRate() + CFG.rateStep); break;
				case 'f': case 'F': toggleFullscreen(); break;
				case 'm': case 'M': player.muted(!player.muted()); break;
				case 'c': case 'C': seekTo(clip.start); break;
				case 'v': case 'V': seekTo(clip.event - 2); break;
				case 'g': case 'G': toggleLoop(); break;
				case 'd': case 'D': if (vid.currentSrc) window.open(vid.currentSrc, '_blank'); break;
				case 'a': case 'A': toggleArchive(); break;
				case 'Escape':
					$('#vne-arch').classList.remove('vne-show');
					$('#vne-keymap').classList.remove('vne-show');
					break;
				case '?': toggleKeymap(); break;
				case '1': case '2': case '3': case '4': {
					const q = QUESTIONS[+k - 1];
					if (e.shiftKey) setVerdict(q, 'positive');
					else setVerdict(q, getVerdict(q) === 'negative' ? 'skip' : 'negative');
					break;
				}
				case '!': setVerdict('aimassist', 'positive'); break;
				case '"': case '@': setVerdict('wallhack', 'positive'); break;
				case '£': case '#': setVerdict('autobhop', 'positive'); break;
				case '$': setVerdict('bot', 'positive'); break;
				case 'z': case 'Z': applyPreset('LEGIT'); break;
				case 'h': case 'H': applyPreset('WH'); break;
				case 'r': case 'R': applyPreset('RAGE'); break;
				case 'x': case 'X': QUESTIONS.forEach(q => setVerdict(q, 'skip')); break;
				case 'Enter': {
					if (a && a.tagName === 'BUTTON') a.blur();
					$('#submitVerdictButton')?.click();
					break;
				}
				case 'Backspace': $('#backbutton')?.click(); break;
				default: handled = false;
			}
			if (handled) { e.preventDefault(); e.stopPropagation(); }
		}, true);

		document.addEventListener('keyup', e => {
			if (e.key === ' ') {
				clearTimeout(holdTimer);
				if (holdEngaged) { player.playbackRate(preHoldRate); renderTick(); }
				else togglePlay();
				holdEngaged = false;
				e.preventDefault(); e.stopPropagation();
			}
		}, true);
	}

	function toggleKeymap() { $('#vne-keymap').classList.toggle('vne-show'); }

	// ---------------- history ----------------
	function vodId() {
		const src = vid?.currentSrc || '';
		const m = src.match(/_([0-9a-f]{16})[0-9a-f]*\.webm/); // 16 hex prefix enough, vods are csow_/cl_ + 64 hex
		return m ? m[1] : src.split('/').pop();
	}
	function history() { return lsGet(LS_HISTORY, []); }
	function shared() { return lsGet(LS_SHARED, []); }
	function exportShare() {
		const name = window.prompt('name to attach to your labels', lsGet(LS_NAME, ''));
		if (name === null) return;
		const n = name.trim() || 'anonymous';
		lsSet(LS_NAME, n);
		const sh = shared();
		const withGroup = sh.length > 0 && window.confirm(`include ${sh.length} imported labels from others?\nok = full group dataset with everyone's names, cancel = just yours`);
		const verdicts = withGroup ? history().concat(sh) : history();
		dl(`vacnet-labels-${n}${withGroup ? '-group' : ''}.json`, JSON.stringify({ vne: 2, name: n, exported: Date.now(), verdicts }, null, 1), 'application/json');
	}
	function importShare(file) {
		file.text().then(txt => {
			let obj;
			try { obj = JSON.parse(txt); } catch (e) { window.alert('not valid json'); return; }
			const verdicts = Array.isArray(obj) ? obj : obj?.verdicts;
			if (!Array.isArray(verdicts)) { window.alert('not a vacnet labels export'); return; }
			let by = String(obj?.name || '').trim();
			if (!by) by = (window.prompt('whose labels are these?') || '').trim() || 'unknown';
			const ownTasks = new Set(history().map(h => String(h.task)));
			const sh = shared();
			const seen = new Set(sh.map(h => h.by + '|' + h.task));
			let added = 0, skipped = 0;
			for (const v of verdicts) {
				if (!v || !v.task || !Array.isArray(v.labels)) { skipped++; continue; }
				const eby = String(v.by || '').trim() || by; // group exports carry per-entry names, keep them
				const key = eby + '|' + v.task;
				if (ownTasks.has(String(v.task)) || seen.has(key)) { skipped++; continue; }
				seen.add(key);
				sh.push({ ...v, by: eby });
				added++;
			}
			if (sh.length > 20000) sh.splice(0, sh.length - 20000);
			lsSet(LS_SHARED, sh);
			renderArchive();
			window.alert(`imported ${added} from ${by}, skipped ${skipped} (duplicates or invalid)`);
		});
	}
	function labelSummary(labels) {
		if (!labels || !labels.length) return { cls: '', txt: '?' };
		if (labels.includes('tag_badclip')) return { cls: '', txt: 'bad clip' };
		if (labels.every(l => l.startsWith('innocent'))) return { cls: 'vne-clean', txt: 'clean' };
		if (labels.every(l => l.startsWith('skip'))) return { cls: '', txt: 'uncertain' };
		const g = labels.filter(l => l.startsWith('guilty')).map(l => l.slice(7));
		return g.length ? { cls: 'vne-guilty', txt: g.join('+') } : { cls: '', txt: 'mixed' };
	}
	const Q_SHORT = { aimassist: 'aim', wallhack: 'wh', autobhop: 'bhop', bot: 'bot' };
	function labelDetail(labels) {
		if (!labels || !labels.length) return '?';
		if (labels.includes('tag_badclip')) return 'bad clip';
		return labels.map(l => {
			const m = l.match(/^(guilty|innocent|skip)_(.+)$/);
			if (!m) return l;
			const q = Q_SHORT[m[2]] || m[2];
			if (m[1] === 'guilty') return `<span class="vne-guilty">${q} yes</span>`;
			if (m[1] === 'innocent') return `<span class="vne-clean">${q} no</span>`;
			return `<span class="vne-skip">${q} ?</span>`;
		}).join('<span class="vne-skip"> · </span>');
	}
	function recordHistory() {
		const labels = $$('#submitverdictform input[name="verdict_labels[]"]').map(i => i.value);
		const h = history();
		h.push({
			task: task.id, vod: vodId(), vodUrl: vid?.currentSrc || '',
			view: task.viewUrl || '', match: (task.matchId && task.matchId !== 'none') ? task.matchId : '',
			start: clip.start, end: clip.end, event: clip.event, labels, ts: Date.now(),
		});
		if (h.length > CFG.historyMax) h.splice(0, h.length - CFG.historyMax);
		lsSet(LS_HISTORY, h);
	}
	function hookSubmit() {
		// form.submit() fires no events, wrap the globals instead
		for (const fn of ['SubmitLabels', 'ReportBadClip']) {
			const orig = window[fn];
			if (typeof orig !== 'function') continue;
			window[fn] = function (...args) { try { recordHistory(); } catch (e) {} return orig.apply(this, args); };
		}
	}
})();
