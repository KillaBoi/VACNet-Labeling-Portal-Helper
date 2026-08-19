// ==UserScript==
// @name         VACNet Review Enhancer
// @namespace    https://counerstri.ke
// @version      0.9.0
// @description  full vod seeking, keyboard controls, verdict presets, fullscreen labelling, scrub previews, no-reload advance, settings and history for the CS2 VACNet labelling portal
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

	// ---------------- storage helpers ----------------
	const $ = (sel, root) => (root || document).querySelector(sel);
	const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
	const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
	const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

	// ---------------- escaping ----------------
	// history rows are built as html strings, and imported files are written by
	// someone else, so anything from a record goes through here on its way into
	// markup. this page holds a live portal session; script injected into it
	// would run with that session.
	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
	const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC[c]);
	// a href is a script sink: javascript: and data: urls execute on click. only
	// http(s) survives, and it comes back already absolute and normalised.
	const safeUrl = u => {
		if (!u) return '';
		try {
			const url = new URL(String(u), location.href);
			return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
		} catch (e) { return ''; }
	};

	// ---------------- config ----------------
	// defaults; everything here is editable in the settings panel (s)
	const DEFAULTS = {
		seekSmall: 5,        // arrows
		seekBig: 10,         // j/l
		holdRate: 2,         // space hold
		rateStep: 0.25,      // - / =
		rateMin: 0.1,
		rateMax: 4,
		fps: 60,             // fallback only, measured off the vod where possible
		historyMax: 5000,
		slowmoLead: 1.5,     // b, seconds before the event to start from
		slowmoRate: 0.25,    // b, rate to replay the event at
		contextNear: 10,     // e, seconds before the clip
		contextFar: 30,      // shift+e
		coverageGuard: true, // warn on confirm if the event moment was never played
		thumbnails: true,    // preview frames when scrubbing the native seek bar
		inPlace: true,       // swap the next clip in instead of reloading the page
	};
	// preset name -> [aimassist, wallhack, autobhop, bot], values: positive|skip|negative
	const PRESETS = {
		LEGIT: ['negative', 'negative', 'negative', 'negative'],
		AIM:   ['positive', 'negative', 'negative', 'negative'],
		WH:    ['negative', 'positive', 'negative', 'negative'],
		RAGE:  ['positive', 'positive', 'positive', 'negative'],
	};
	// bounds for the stored settings. a value outside these is a corrupt or
	// hostile store rather than a preference, and some of them (rateMin over
	// rateMax, fps of zero) break playback outright.
	const LIMITS = {
		seekSmall: [1, 120], seekBig: [1, 300], holdRate: [0.1, 8],
		rateStep: [0.05, 2], rateMin: [0.05, 4], rateMax: [0.25, 8],
		fps: [1, 480], historyMax: [10, 50000],
		slowmoLead: [0, 30], slowmoRate: [0.05, 4],
		contextNear: [1, 600], contextFar: [1, 600],
	};
	// localStorage is not a trusted input: every script on the page can write it.
	// only keys we declare, coerced to the type of their default. building the
	// result key by key from DEFAULTS is also what keeps a "__proto__" key in the
	// stored json from being assigned through.
	function mergeSettings(stored) {
		const src = (stored && typeof stored === 'object') ? stored : {};
		const out = {};
		for (const k of Object.keys(DEFAULTS)) {
			const d = DEFAULTS[k];
			const raw = Object.prototype.hasOwnProperty.call(src, k) ? src[k] : d;
			if (typeof d === 'boolean') { out[k] = raw === true; continue; }
			const n = Number(raw);
			if (!isFinite(n)) { out[k] = d; continue; }
			const lim = LIMITS[k];
			out[k] = lim ? Math.min(lim[1], Math.max(lim[0], n)) : n;
		}
		if (out.rateMin > out.rateMax) { out.rateMin = DEFAULTS.rateMin; out.rateMax = DEFAULTS.rateMax; }
		return out;
	}
	// mutated in place, never reassigned, so every CFG.x read below stays live
	const CFG = mergeSettings(lsGet('vneSettings', null));

	// ---------------- portal selectors ----------------
	// every assumption about valve's markup lives here. the portal is unversioned
	// server-rendered html, so when it changes this is the only block to edit, and
	// the settings panel says which entry broke instead of the feature just dying.
	const SEL = {
		player:      { s: '#video', req: true, note: 'video.js keeps this id on the wrapper it swaps in' },
		media:       { s: '#video video', note: 'the real media element once video.js has upgraded' },
		source:      { s: '#video source', note: 'carries the vod url before currentSrc is populated' },
		container:   { s: '.videocontainer', req: true, note: 'mount point for the clip bar' },
		form:        { s: '#submitverdictform', req: true, note: 'task id and the hidden verdict_labels[]' },
		taskInput:   { s: '#submitverdictform input[name="verdict_task"]', note: 'task id' },
		verdicts:    { s: '.verdicts-container', req: true, note: 'preset row is inserted before this' },
		verdictBtn:  { s: '.verdictbutton', note: 'per question yes / unsure / no, relabelled by the script' },
		submitBtn:   { s: '#submitVerdictButton', note: 'recreated on every mode change, never cache the node' },
		status:      { s: '#statustext', note: 'the submitting pill, normally cleared by the page reload' },
		clipCount:   { s: '.PageHeader .ClipCount', note: 'lifetime counter, refreshed on an in place swap' },
		backBtn:     { s: '#backbutton', tr: true, note: 'confirm step only, which is how we know which step we are on' },
		details:     { s: '#detailsModalContent', note: 'the modal the portal itself can never open' },
		detailCells: { s: '#detailsModalContent .detailstable td', note: 'key / value pairs for app and match id' },
		viewLink:    { s: '#detailsModalContent a[href*="/vacnet/view"]', note: 'permalink to the evidence view' },
		header:      { s: '.PageHeader', note: 'top bar' },
		logout:      { s: '.PageHeader .right a[href*="logout"]', note: 'account row, also carries the reviewer name' },
		progress:    { s: '.vjs-progress-holder', note: 'native seek bar, takes the clip and history bands' },
		footer:      { s: '.footer-container', note: 'fixed footer, hidden by the wide layout' },
	};
	const S = (k, root) => $(SEL[k].s, root);
	const SS = (k, root) => $$(SEL[k].s, root);
	function probe(root) {
		return Object.keys(SEL).map(k => ({
			key: k, sel: SEL[k].s, note: SEL[k].note,
			req: SEL[k].req === true, tr: SEL[k].tr === true,
			found: !!$(SEL[k].s, root),
		}));
	}
	const QUESTIONS = ['aimassist', 'wallhack', 'autobhop', 'bot'];
	const LS_HISTORY = 'vneHistory';
	const LS_SHARED = 'vneShared';
	const LS_NAME = 'vneName';
	const LS_UPDATE = 'vneUpdate';
	const LS_CLIPLOCK = 'vneClipLock';
	const LS_NAMELOCK = 'vneNameLock';
	const LS_MORE = 'vneMore';
	const VERSION = (typeof GM_info !== 'undefined' && GM_info.script?.version) || '0.9.0'; // fallback in sync with @version
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
	const fmt = s => {
		if (!isFinite(s)) return '0:00';
		const m = Math.floor(s / 60), sec = s - m * 60;
		return m + ':' + sec.toFixed(1).padStart(4, '0');
	};
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

	// ---------------- state ----------------
	let player = null;          // videojs player
	let vid = null;             // raw <video>
	let clip = { start: 0, end: 0, event: 0, vodUrl: '', ok: false };
	let task = { id: null, viewUrl: null, app: null, matchId: null };
	let clipLoop = false;
	let clipLock = lsGet(LS_CLIPLOCK, false); // persists across clips, confines playback to clip bounds
	let nameLocked = lsGet(LS_NAMELOCK, false); // reviewer name pinned visible, persists across clips
	let holdTimer = null, holdEngaged = false, preHoldRate = 1;
	let slowmoActive = false; // slow-mo owns the rate until you go somewhere else
	let coverage = makeCoverage(0, 0);
	let booted = false;
	let confirmedChoices = null; // captured on proceed, the confirm step has no radios left
	let coverageWarned = false;
	let announcedEventSeen = false;
	let ui = {};

	// ---------------- watch coverage ----------------
	// which parts of the assigned clip were actually played, so confirming can
	// tell reviewing a clip apart from scrubbing past it. only marked while
	// playing, never while paused or seeking.
	// how far playback can move between two samples and still be playback: the
	// tick runs every 250ms and the fastest rate is 4x, so a genuine gap is about
	// a second at worst. anything larger is a seek and must not be filled in.
	const COVERAGE_MAX_STEP = 2;

	function makeCoverage(start, end, bins) {
		bins = bins || 120;
		const span = Math.max(end - start, 0);
		const seen = new Array(bins).fill(false);
		let last = null;
		const idx = t => span <= 0 ? 0 : clamp(Math.floor((t - start) / span * bins), 0, bins - 1);
		return {
			// fills the range covered since the previous sample rather than marking
			// a single point. a bin is a fraction of a second while the tick only
			// runs a few times a second, so marking points left most of a watched
			// clip unmarked and missed the event's own bin more often than not.
			mark(t) {
				if (span <= 0) return;
				if (t >= start && t <= end) {
					const to = idx(t);
					const bridged = last !== null && Math.abs(t - last) <= COVERAGE_MAX_STEP;
					const from = bridged ? idx(last) : to;
					for (let i = Math.min(from, to); i <= Math.max(from, to); i++) seen[i] = true;
				}
				// tracked even outside the clip, so seeking in from elsewhere is not
				// mistaken for having played the distance
				last = t;
			},
			fraction() { return seen.filter(Boolean).length / bins; },
			watchedAt(t) { return span > 0 && t >= start && t <= end && seen[idx(t)] === true; },
		};
	}

	// ---------------- clip identity ----------------
	// the portal re-serves the same moment under a new task id, so a task id is
	// no good as an identity. vod + event is stable across re-serves, and it is
	// what separates "this exact clip again" from "same match, another moment".
	function clipKey() { return vodId() + ':' + (clip.event || 0).toFixed(3); }
	function entryKey(h) { return h.key || ((h.vod || '') + ':' + (+h.event || 0).toFixed(3)); }

	// ---------------- init ----------------
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}

	function boot() {
		if (booted) return; // one manager firing both document-start and DOMContentLoaded would double every panel
		if (!S('player') || !S('form')) return; // not the review page
		booted = true;
		parseClipMeta();
		parseTaskMeta();
		coverage = makeCoverage(clip.start, clip.end);
		waitForPlayer();
	}

	// in a document fetched with fetch() the media element was never upgraded, so
	// currentSrc is empty there and the <source> attribute is the only url
	function vodUrlFrom(root) {
		const m = S('media', root);
		if (m && m.currentSrc) return m.currentSrc;
		return S('source', root)?.getAttribute('src') || '';
	}

	// both parsers take a root so the same code reads the live page and the page
	// the portal would have navigated to
	function parseClipFrom(root) {
		for (const sc of $$('script:not([src])', root)) {
			const t = sc.textContent;
			const m1 = t.match(/const startTime = ([\d.]+)/);
			if (!m1) continue;
			const m2 = t.match(/startTime \+ ([\d.]+)/);
			const m3 = t.match(/const eventTime = ([\d.]+)/);
			const start = parseFloat(m1[1]);
			if (!isFinite(start)) continue;
			return {
				start,
				end: m2 ? start + parseFloat(m2[1]) : start + 12,
				event: m3 ? parseFloat(m3[1]) : start,
				vodUrl: vodUrlFrom(root),
				ok: true,
			};
		}
		return null;
	}

	function parseTaskFrom(root) {
		const t = { id: null, viewUrl: null, app: null, matchId: null };
		t.id = S('taskInput', root)?.value || null;
		// resolved by hand, a parsed document has no base of its own
		const href = S('viewLink', root)?.getAttribute('href');
		t.viewUrl = href ? new URL(href, location.href).toString() : null;
		const cells = SS('detailCells', root);
		for (let i = 0; i < cells.length - 1; i += 2) {
			const k = cells[i].textContent.trim();
			if (k === 'App') t.app = cells[i + 1].textContent.trim();
			if (k === 'Match ID') t.matchId = cells[i + 1].textContent.trim();
		}
		return t;
	}

	function parseClipMeta() {
		const c = parseClipFrom(document);
		if (!c) return void console.warn('[vne] clip constants not found, markers disabled');
		clip = c;
	}

	function parseTaskMeta() { task = parseTaskFrom(document); }

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
			hookGuard();
			if (!clampBlocked) console.warn('[vne] clamp interval was not intercepted, use the nuke button');
		});
	}

	// ---------------- dialogs ----------------
	// the three overlays are modal in behaviour but were plain divs: no name, no
	// focus moved in, and tab walked straight out into the page behind them.
	const FOCUSABLE = 'button, [href], select, input:not([type=hidden]), textarea, [tabindex]:not([tabindex="-1"])';

	function focusablesIn(ov) {
		return $$(FOCUSABLE, ov).filter(el => el.offsetParent !== null && !el.disabled);
	}

	function setupDialog(ov, labelId) {
		ov.setAttribute('role', 'dialog');
		ov.setAttribute('aria-modal', 'true');
		ov.setAttribute('tabindex', '-1');
		if (labelId) ov.setAttribute('aria-labelledby', labelId);
		ov.addEventListener('keydown', e => {
			if (e.key !== 'Tab') return;
			const items = focusablesIn(ov);
			if (!items.length) return void e.preventDefault();
			const first = items[0], last = items[items.length - 1];
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		});
	}

	function dialogOpen(ov) { return ov.classList.contains('vne-show'); }

	// focus goes back where it came from, so closing does not dump the caret at
	// the top of the document
	function showDialog(ov, show) {
		if (show === dialogOpen(ov)) return;
		if (show) {
			ov.vneReturn = document.activeElement;
			ov.classList.add('vne-show');
			const items = focusablesIn(ov);
			(items[0] || ov).focus();
		} else {
			ov.classList.remove('vne-show');
			const back = ov.vneReturn;
			ov.vneReturn = null;
			if (back && back.isConnected && back.focus) back.focus();
		}
	}

	// reports whether it actually closed anything, so escape is only consumed
	// when there was something to close
	function closeOverlays() {
		let closed = false;
		for (const id of ['#vne-arch', '#vne-set', '#vne-keymap']) {
			const ov = $(id);
			if (ov && dialogOpen(ov)) { showDialog(ov, false); closed = true; }
		}
		return closed;
	}

	// ---------------- announcements ----------------
	// the readout in the bar changes several times a second; announcing that
	// would be unusable. only the transitions worth hearing come through here.
	function buildAnnouncer() {
		const el = document.createElement('div');
		el.id = 'vne-live';
		el.setAttribute('aria-live', 'polite');
		el.setAttribute('aria-atomic', 'true');
		document.body.appendChild(el);
		ui.live = el;
	}
	function announce(msg) {
		if (ui.live && ui.live.textContent !== msg) ui.live.textContent = msg;
	}

	// ---------------- ui ----------------
	function buildUI() {
		injectCSS();
		buildBar();
		buildOutClipBanner();
		buildLoading();
		buildProgressOverlay();
		buildPresetRow();
		buildHistoryPanel();
		buildArchive();
		buildSettings();
		buildHud();
		buildThumbs();
		buildKeymapOverlay();
		buildAnnouncer();
		buildVersionBadge();
		hookRelabel();
		hookCensorName();
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

	// the swap takes a network round trip, and without this the page looks frozen
	// on the clip you just judged
	function buildLoading() {
		const host = $('.video-js') || $('.videocontainer');
		if (!host) return;
		const el = document.createElement('div');
		el.id = 'vne-loading';
		el.innerHTML = '<span class="vne-spin" aria-hidden="true"></span><span>loading next clip\u2026</span>';
		host.appendChild(el);
		ui.loading = el;
	}

	function setLoading(on) {
		if (ui.loading) ui.loading.classList.toggle('vne-show', on);
		if (on) announce('labels submitted, loading the next clip');
	}

	function buildOutClipBanner() {
		if (!clip.ok) return;
		const b = document.createElement('button');
		b.type = 'button';
		b.id = 'vne-outclip';
		b.textContent = '⚠ outside the assigned clip · click to jump back';
		b.title = 'you are watching the rest of the vod, not the clip valve assigned';
		b.onclick = () => { endSlowmo(); seekTo(clip.start); };
		($('.video-js') || $('.videocontainer')).appendChild(b);
		ui.outclip = b;
	}

	function injectCSS() {
		const css = `
		/* the portal is dark; saying so is what fixes the native select popup and
		   the overlay scrollbars, which otherwise render light on windows */
		:root { color-scheme: dark; }

		/* a named ladder, so a new layer lands in the right place instead of at
		   whatever beats the last one. the dialog values stay high on purpose:
		   they have to clear valve's own stacking, which we do not control. */
		:root {
			--vne-z-marker: 1;
			--vne-z-tick: 2;
			--vne-z-banner: 10;
			--vne-z-preview: 25;
			--vne-z-hud: 30;
			--vne-z-loading: 40;
			--vne-z-dialog: 99998;
			--vne-z-dialog-top: 99999;
			--vne-z-badge: 100000;
		}

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
		/* keyboard focus was invisible everywhere. :focus-visible so a mouse click
		   does not leave a ring behind. */
		/* only elements that can actually take focus. the history rows, the copy
		   spans, the clip scrubber and the name mask are still click-only, and
		   styling them here would have implied otherwise. */
		.vne-btn:focus-visible,
		.vne-hud-b:focus-visible,
		#vne-outclip:focus-visible,
		#vne-arch-q:focus-visible,
		.vne-set-row input:focus-visible {
			outline: 2px solid #e8a33d;
			outline-offset: 2px;
			border-radius: 3px;
		}
		#vne-lock-wrap:focus-within { outline: 2px solid #e8a33d; outline-offset: 2px; border-radius: 3px; }
		select.vne-btn { font-family: inherit; height: 21px; padding: 1px 4px; }
		select.vne-btn option { background: #262b33; color: #c8cdd4; }
		.vne-btn.vne-on { background: #e8a33d; color: #15181d; border-color: #e8a33d; }
		#vne-time { margin-left: auto; color: #8a919c; white-space: nowrap; font-variant-numeric: tabular-nums; }
		#vne-time b { color: #e8a33d; font-weight: 600; }
		#vne-time .vne-unseen, #vne-time b.vne-unseen { color: #ff5252; }
		#vne-task { color: #8a919c; white-space: nowrap; }
		#vne-task a { color: #6db3e8; text-decoration: none; }
		#vne-task a:hover { text-decoration: underline; }
		#vne-match { cursor: pointer; border-bottom: 1px dotted #8a919c; }
		#vne-nuke { background: #7a2b2b; border-color: #a03535; color: #ffdede; }
		#vne-bad { color: #f2c94c; }
		#vne-more { display: inline-flex; align-items: center; gap: 6px; }
		#vne-lock-wrap { display: inline-flex; align-items: center; gap: 4px; color: #c8cdd4; cursor: pointer; user-select: none; font-size: 12px; }
		#vne-lock-wrap input { accent-color: #e8a33d; cursor: pointer; margin: 0; }
		#vne-outclip { display: none; position: absolute; top: 0; left: 0; right: 0; z-index: var(--vne-z-banner); border: 0; width: 100%; background: #e8a33dd9; color: #15181d; font: 700 13px/1 "Motiva Sans", Arial, sans-serif; text-align: center; padding: 6px 0; cursor: pointer; user-select: none; }
		#vne-outclip.vne-show { display: block; }
		#vne-ver { position: fixed; right: 8px; bottom: 6px; z-index: var(--vne-z-badge); font: 11px/1 monospace; color: #7d8694; text-decoration: none; user-select: none; }
		#vne-ver:hover { color: #8a919c; }
		#vne-ver.vne-ver-update { color: #6dd36d; font-weight: 700; }
		#vne-ver.vne-ver-update:hover { color: #8ff08f; }

		/* clip band on native full progress bar */
		.vjs-progress-holder { overflow: visible; }
		.vne-band { position: absolute; top: 0; height: 100%; background: #e8a33d66; pointer-events: none; z-index: var(--vne-z-marker); }
		.vne-band.vne-hist { background: #4caf5044; }
		.vne-band.vne-shared { background: #6db3e844; }
		.vne-tick { position: absolute; top: -3px; width: 2px; height: calc(100% + 6px); background: #ff5252; pointer-events: none; z-index: var(--vne-z-tick); }
		.vne-tick.vne-hist { background: #4caf50; }

		/* presets */
		/* space the whole button row off the questions box; on the container so back + confirm stay aligned */
		#submitbuttons { margin-top: 26px !important; }

		#vne-presets { display: flex; gap: 8px; margin: 0 0 10px; }
		#vne-presets .vne-btn { flex: 1; text-align: center; font-weight: 700; padding: 6px 0; }
		#vne-preset-legit { background: #2e7d32; border-color: #2e7d32; color: #eaffea; }
		#vne-preset-aim { background: #7a8c1f; border-color: #7a8c1f; color: #f6ffe0; }
		#vne-preset-wh { background: #c98a1b; border-color: #c98a1b; color: #fff7e5; }
		#vne-preset-rage { background: #b03030; border-color: #b03030; color: #ffecec; }
		/* square, width is set from its own height in buildPresetRow.
		   two ids so it outranks the flex:1 on #vne-presets .vne-btn above */
		#vne-presets #vne-preset-reset { flex: 0 0 auto; box-sizing: border-box; padding: 0; font-size: 15px; line-height: 1; display: flex; align-items: center; justify-content: center; }
		#vne-presets .vne-btn:hover { filter: brightness(1.2); }

		/* reviewer name in the portal header, masked until you hold the hover for 3s.
		   the name is never in the dom while masked, so length and glyph shapes leak nothing */
		.vne-name { position: relative; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
		/* fixed width + overflow hidden so a long name cannot widen the blur, blur radius
		   is over half the font size so no glyph edge survives */
		.vne-name-text { display: inline-block; width: 82px; overflow: hidden; white-space: nowrap; filter: blur(7px); transition: filter .15s ease; }
		.vne-name.vne-revealed .vne-name-text { width: auto; filter: none; }
		.vne-name-eye { position: absolute; left: 0; top: 50%; width: 82px; transform: translateY(-50%); display: flex; justify-content: center; pointer-events: none; color: #c8cdd4; transition: opacity .15s, color .12s; }
		.vne-name-eye svg { width: 15px; height: 15px; display: block; }
		.vne-name:hover .vne-name-eye { color: #e8a33d; }
		.vne-name.vne-revealed .vne-name-eye { opacity: 0; }
		.vne-name-ring { width: 13px; height: 13px; transform: rotate(-90deg); opacity: 0; transition: opacity .12s; }
		.vne-name-ring circle { fill: none; stroke-width: 3; }
		.vne-name-ring .vne-ring-bg { stroke: #ffffff26; }
		.vne-name-ring .vne-ring-fg { stroke: #e8a33d; stroke-dasharray: 50.3; stroke-dashoffset: 50.3; }
		.vne-name:hover .vne-name-ring { opacity: 1; }
		.vne-name:hover .vne-ring-fg { animation: vne-ring 1s linear forwards; }
		.vne-name.vne-revealed .vne-name-ring { opacity: 0; }
		@keyframes vne-ring { to { stroke-dashoffset: 0; } }
		/* click to pin it open, the padlock takes the ring's slot */
		.vne-name.vne-locked .vne-name-ring { display: none; }
		.vne-name-lock { display: none; color: #e8a33d; }
		.vne-name-lock svg { width: 12px; height: 12px; display: block; }
		.vne-name.vne-locked .vne-name-lock { display: block; }
		.vne-name.vne-locked:hover .vne-name-lock { color: #f2bb63; }

		/* history */
		#vne-history { margin-top: 10px; font: 11px/1.5 "Motiva Sans", Arial, sans-serif; color: #8a919c; }
		#vne-history h4 { margin: 0 0 4px; font-size: 12px; color: #e8a33d; }
		#vne-history h4.vne-h4-sub { margin-top: 10px; color: #8a919c; }
		#vne-history .vne-hnote { color: #7d8694; margin-bottom: 2px; }
		#vne-history .vne-unseen { color: #ff5252; }
		#vne-history .vne-hrow { display: flex; gap: 8px; justify-content: space-between; border-bottom: 1px solid #262b33; padding: 1px 2px; font-variant-numeric: tabular-nums; }
		#vne-history .vne-hrow.vne-apply { cursor: pointer; }
		#vne-history .vne-hrow.vne-apply:hover { background: #262b33; }
		#vne-history .vne-hlabels { color: #c8cdd4; }
		#vne-history .vne-hlabels.vne-clean { color: #4caf50; }
		#vne-history .vne-hlabels.vne-guilty { color: #ff5252; }

		/* archive overlay */
		#vne-arch { display: none; position: fixed; inset: 0; z-index: var(--vne-z-dialog); background: #0f1216f2; overflow-y: auto; padding: 24px 40px; font: 13px/1.5 "Motiva Sans", Arial, sans-serif; color: #c8cdd4; }
		#vne-arch.vne-show { display: block; }
		#vne-arch, #vne-set { overscroll-behavior: contain; }
		#vne-arch-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
		#vne-arch-top h2 { margin: 0 12px 0 0; font-size: 18px; color: #e8a33d; }
		#vne-arch-close { margin-left: auto; font-size: 16px; }
		#vne-arch-q { background: #1b2026; border: 1px solid #343b46; color: #c8cdd4; padding: 4px 10px; border-radius: 3px; width: 240px; }
		#vne-arch-stats { color: #8a919c; margin-bottom: 10px; }
		/* the table is nowrap by design, so it is the body that scrolls, not the
		   page. contain stops that scroll chaining out to the portal behind it. */
		#vne-arch-body { overflow-x: auto; overscroll-behavior: contain; }
		#vne-arch table { width: 100%; border-collapse: collapse; }
		#vne-arch th { text-align: left; padding: 4px 10px; color: #8a919c; font-weight: 600; border-bottom: 1px solid #343b46; position: sticky; top: -24px; background: #0f1216; }
		#vne-arch td { text-align: left; padding: 3px 10px; border-bottom: 1px solid #1e232a; white-space: nowrap; font-variant-numeric: tabular-nums; }
		#vne-arch td a { color: #6db3e8; text-decoration: none; }
		#vne-arch td a:hover { text-decoration: underline; }
		#vne-arch .vne-clean { color: #4caf50; }
		#vne-arch .vne-guilty { color: #ff5252; }
		#vne-arch .vne-mono { font-family: monospace; font-size: 12px; color: #8a919c; }
		/* a long imported name or url used to push the whole table sideways */
		#vne-arch td.vne-by, #vne-arch td.vne-mono { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
		#vne-arch .vne-skip { color: #8a919c; }
		#vne-arch .vne-copy { cursor: pointer; border-bottom: 1px dotted #8a919c; }
		.vne-by { color: #8a919c; font-style: italic; }
		.vne-btn.vne-filter-on { background: #e8a33d; color: #15181d; border-color: #e8a33d; }

		/* covers the player while the next clip is fetched and swapped in */
		#vne-loading { display: none; position: absolute; inset: 0; z-index: var(--vne-z-loading); align-items: center; justify-content: center; gap: 10px; background: #0f1216cc; color: #c8cdd4; font: 600 14px/1 "Motiva Sans", Arial, sans-serif; user-select: none; }
		#vne-loading.vne-show { display: flex; }
		.vne-spin { width: 16px; height: 16px; border: 2px solid #343b46; border-top-color: #e8a33d; border-radius: 50%; animation: vne-spin .7s linear infinite; }
		@keyframes vne-spin { to { transform: rotate(360deg); } }
		/* scrub preview */
		#vne-thumb { display: none; position: absolute; bottom: 44px; z-index: var(--vne-z-preview); transform: translateX(-50%); background: #0f1216e6; border: 1px solid #343b46; border-radius: 4px; padding: 3px; pointer-events: none; }
		#vne-thumb.vne-show { display: block; }
		#vne-thumb-img { width: 160px; height: 90px; background: #000; border-radius: 2px; overflow: hidden; }
		#vne-thumb-img canvas { display: block; width: 160px; height: 90px; }
		#vne-thumb-time { text-align: center; font: 11px/1.5 monospace; color: #c8cdd4; }

		/* fullscreen verdict hud */
		#vne-hud { display: none; position: absolute; right: 16px; bottom: 70px; z-index: var(--vne-z-hud); background: #0f1216d9; border: 1px solid #343b46; border-radius: 6px; padding: 10px 12px; font: 13px/1.4 "Motiva Sans", Arial, sans-serif; color: #c8cdd4; user-select: none; }
		.video-js.vjs-fullscreen #vne-hud.vne-show { display: block; }
		.vne-hud-row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
		.vne-hud-q { width: 88px; color: #8a919c; }
		.vne-hud-b { background: #262b33; color: #c8cdd4; border: 1px solid #343b46; border-radius: 3px; padding: 3px 10px; cursor: pointer; font-size: 12px; min-width: 58px; }
		.vne-hud-b:hover { background: #343b46; }
		.vne-hud-b.vne-on { background: var(--c); border-color: var(--c); color: #15181d; font-weight: 700; }
		#vne-hud.vne-hud-locked .vne-hud-b { cursor: default; opacity: .85; }
		#vne-hud.vne-hud-locked .vne-hud-b:hover { background: #262b33; }
		#vne-hud.vne-hud-locked .vne-hud-b.vne-on:hover { background: var(--c); }
		.vne-hud-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }

		/* settings overlay */
		#vne-set { display: none; position: fixed; inset: 0; z-index: var(--vne-z-dialog); background: #0f1216d9; overflow-y: auto; font: 13px/1.5 "Motiva Sans", Arial, sans-serif; color: #c8cdd4; }
		#vne-set.vne-show { display: block; }
		#vne-set-box { max-width: 620px; margin: 40px auto; background: #15181d; border: 1px solid #343b46; border-radius: 6px; padding: 16px 22px 22px; }
		#vne-set-top { display: flex; align-items: center; margin-bottom: 6px; }
		#vne-set-top h2 { margin: 0; font-size: 18px; color: #e8a33d; }
		#vne-set-close { margin-left: auto; font-size: 16px; }
		#vne-set-body h3 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #8a919c; border-bottom: 1px solid #262b33; padding-bottom: 4px; }
		.vne-set-row { display: flex; align-items: center; gap: 10px; padding: 3px 2px; }
		.vne-set-row label { flex: 1; }
		.vne-set-row input[type=number] { width: 90px; background: #1b2026; border: 1px solid #343b46; color: #c8cdd4; padding: 3px 6px; border-radius: 3px; }
		.vne-set-row input[type=checkbox] { accent-color: #e8a33d; cursor: pointer; margin: 0; }
		.vne-set-note { color: #8a919c; font-size: 12px; margin-bottom: 6px; }
		.vne-set-hook { display: flex; gap: 10px; justify-content: space-between; padding: 1px 2px; border-bottom: 1px solid #1e232a; font-size: 12px; }
		.vne-set-hook .vne-mono { font-family: monospace; color: #8a919c; }
		.vne-ok { color: #4caf50; }
		.vne-miss { color: #e8a33d; }
		.vne-miss-req { color: #ff5252; font-weight: 700; }

		/* announcements only, never seen */
		.vne-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
		#vne-live { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }

		/* keymap overlay */
		#vne-keymap { display: none; position: fixed; z-index: var(--vne-z-dialog-top); top: 50%; left: 50%; transform: translate(-50%, -50%); background: #15181de8; border: 1px solid #343b46; border-radius: 6px; padding: 16px 22px; color: #c8cdd4; font: 12px/1.7 monospace; white-space: pre; }
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
		const vodUrl = safeUrl(clip.vodUrl || vid?.currentSrc || '');
		bar.innerHTML = `
			<div id="vne-clipbar" title="clip timeline, click to seek">
				<div id="vne-clipbar-fill"></div>
				<div id="vne-clipbar-event"></div>
				<div id="vne-clipbar-head"></div>
				<span class="vne-label">CLIP</span>
			</div>
			<div id="vne-row">
				<button class="vne-btn" id="vne-play" title="space / k" aria-label="play or pause">▶</button>
				<button class="vne-btn" id="vne-fb" title=", frame back" aria-label="previous frame">⏮</button>
				<button class="vne-btn" id="vne-ff" title=". frame fwd" aria-label="next frame">⏭</button>
				<select class="vne-btn" id="vne-rate" title="playback rate, - / = to step, hold space for 2x" aria-label="playback rate"></select>
				<button class="vne-btn" id="vne-more-toggle" title="show / hide extra buttons (clip, event, loop, keys, download)" aria-label="show or hide the extra controls" aria-expanded="false" aria-controls="vne-more">⋯</button>
				<span id="vne-more">
					<button class="vne-btn" id="vne-clipstart" title="c">clip</button>
					<button class="vne-btn" id="vne-event" title="v">event</button>
					<button class="vne-btn" id="vne-slowmo" title="b, replay the flagged moment slowly">slow-mo</button>
					<button class="vne-btn" id="vne-runup" title="e / shift+e, start before the clip">run-up</button>
					<button class="vne-btn" id="vne-loop" title="g, restore original clip looping">loop</button>
					<button class="vne-btn" id="vne-keys" title="?">keys</button>
					<a class="vne-btn" id="vne-vod" href="${esc(vodUrl)}" target="_blank" rel="noreferrer noopener" title="d, download / open the full vod webm">download entire video</a>
				</span>
				<label id="vne-lock-wrap" title="lock playback to the assigned clip so you cannot watch the rest of the demo. stays on across clips."><input type="checkbox" id="vne-lock"> clip lock</label>
				<button class="vne-btn" id="vne-fs" title="f" aria-label="fullscreen">⛶</button>
				<button class="vne-btn" id="vne-bad" title="report bad clip, submits immediately">bad clip</button>
				<button class="vne-btn" id="vne-hist-btn" title="a, labelling history">history</button>
				<button class="vne-btn" id="vne-set-btn" title="s, settings">settings</button>
				<span id="vne-task">${taskHtml()}</span>
				<span id="vne-time"></span>
			</div>`;
		$('.videocontainer').appendChild(bar);

		ui.play = $('#vne-play'); ui.rate = $('#vne-rate'); ui.loop = $('#vne-loop');
		ui.time = $('#vne-time'); ui.clipbar = $('#vne-clipbar');
		ui.clipFill = $('#vne-clipbar-fill'); ui.clipHead = $('#vne-clipbar-head'); ui.clipEvent = $('#vne-clipbar-event');

		ui.play.onclick = togglePlay;
		$('#vne-fb').onclick = () => frameStep(-1);
		$('#vne-ff').onclick = () => frameStep(1);
		// blur after choosing, or every shortcut would keep going to the dropdown
		ui.rate.onchange = () => { setRate(parseFloat(ui.rate.value)); ui.rate.blur(); };
		renderRateSelect();
		$('#vne-clipstart').onclick = () => { endSlowmo(); seekTo(clip.start); };
		$('#vne-event').onclick = () => { endSlowmo(); seekTo(clip.event - 2); }; // land just before the moment
		$('#vne-slowmo').onclick = slowmoEvent;
		$('#vne-runup').onclick = ev => seekContext(ev.shiftKey ? CFG.contextFar : CFG.contextNear);
		ui.loop.onclick = toggleLoop;
		const lockEl = $('#vne-lock');
		lockEl.checked = clipLock;
		lockEl.onchange = () => { clipLock = lockEl.checked; lsSet(LS_CLIPLOCK, clipLock); if (clipLock) enforceClipLock(); };
		$('#vne-fs').onclick = toggleFullscreen;
		$('#vne-keys').onclick = toggleKeymap;
		$('#vne-set-btn').onclick = toggleSettings;
		const moreEl = $('#vne-more'), moreToggle = $('#vne-more-toggle');
		const applyMore = on => {
			moreEl.style.display = on ? '' : 'none';
			moreToggle.classList.toggle('vne-on', on);
			moreToggle.setAttribute('aria-expanded', String(on));
		};
		applyMore(lsGet(LS_MORE, false));
		moreToggle.onclick = () => { const on = moreEl.style.display === 'none'; applyMore(on); lsSet(LS_MORE, on); };
		$('#vne-bad').onclick = () => { if (window.confirm('report bad clip? submits immediately')) window.ReportBadClip(); };
		$('#vne-hist-btn').onclick = toggleArchive;
		bindMatchCopy();

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
			endSlowmo();
			const r = ui.clipbar.getBoundingClientRect();
			const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
			seekTo(clip.start + frac * (clip.end - clip.start));
		};
		let dragging = false;
		ui.clipbar.addEventListener('mousedown', e => { dragging = true; clipSeek(e); });
		document.addEventListener('mousemove', e => { if (dragging) clipSeek(e); });
		document.addEventListener('mouseup', () => { dragging = false; });
	}

	function taskHtml() {
		if (!task.id) return 'task ?';
		// task metadata is read out of a page fetched during an in place advance,
		// so it is parsed input like any other
		const view = safeUrl(task.viewUrl);
		const id = view ? `<a href="${esc(view)}" target="_blank" rel="noreferrer noopener">#${esc(task.id)}</a>` : '#' + esc(task.id);
		const match = task.matchId && task.matchId !== 'none'
			? ` · match <span id="vne-match" title="click to copy">${esc(task.matchId)}</span>` : '';
		return `task ${id}${match}`;
	}
	function bindMatchCopy() {
		const mEl = $('#vne-match');
		if (mEl) mEl.onclick = () => { navigator.clipboard.writeText(task.matchId); mEl.style.color = '#4caf50'; setTimeout(() => mEl.style.color = '', 600); };
	}
	// the task readout, the download link and the match id all follow the clip
	function updateTaskInfo() {
		const el = $('#vne-task');
		if (el) el.innerHTML = taskHtml();
		const vod = $('#vne-vod');
		if (vod) vod.href = safeUrl(clip.vodUrl) || '#';
		bindMatchCopy();
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
			<button class="vne-btn" id="vne-preset-aim" title="q">AIM</button>
			<button class="vne-btn" id="vne-preset-wh" title="h">WH</button>
			<button class="vne-btn" id="vne-preset-rage" title="r">RAGE</button>
			<button class="vne-btn" id="vne-preset-reset" title="x, reset to all Unsure" aria-label="reset">↺</button>`;
		const target = $('.verdicts-container');
		target.parentNode.insertBefore(row, target);
		$('#vne-preset-legit').onclick = () => applyPreset('LEGIT');
		$('#vne-preset-aim').onclick = () => applyPreset('AIM');
		$('#vne-preset-wh').onclick = () => applyPreset('WH');
		$('#vne-preset-rage').onclick = () => applyPreset('RAGE');
		const reset = $('#vne-preset-reset');
		reset.onclick = () => QUESTIONS.forEach(q => setVerdict(q, 'skip'));
		// square it off the row height, the portal's own button styling decides that
		const squareReset = () => {
			const w = reset.offsetHeight + 'px';
			if (reset.offsetHeight && reset.style.width !== w) reset.style.width = w; // guard, observer fires on our own write
		};
		requestAnimationFrame(squareReset);
		if (window.ResizeObserver) new ResizeObserver(squareReset).observe(row);
	}

	// the header prints the reviewer name as a bare text node next to Logout.
	// wrap it so it can be blurred out under an eye icon, hold the hover for
	// NAME_HOLD ms, tracked by a ring, to read it. re-applied because the header
	// is re-rendered on navigation within the portal
	const NAME_HOLD = 1000; // keep in sync with the vne-ring animation duration
	const EYE_SVG = '<span class="vne-name-eye" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg></span>';
	const LOCK_SVG = '<span class="vne-name-lock" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
		'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>';
	function censorName() {
		for (const p of $$('.PageHeader .right p')) {
			if (!p.querySelector('a[href*="logout"]')) continue;
			if (p.querySelector('.vne-name')) continue;
			for (const node of Array.from(p.childNodes)) {
				if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
				const span = document.createElement('span');
				span.className = 'vne-name' + (nameLocked ? ' vne-revealed vne-locked' : '');
				span.innerHTML = '<span class="vne-name-text"></span>' + EYE_SVG +
					'<svg class="vne-name-ring" viewBox="0 0 20 20" aria-hidden="true">' +
					'<circle class="vne-ring-bg" cx="10" cy="10" r="8"/>' +
					'<circle class="vne-ring-fg" cx="10" cy="10" r="8"/></svg>' + LOCK_SVG;
				span.querySelector('.vne-name-text').textContent = node.textContent.trim();
				let timer = 0;
				const hold = () => { timer = setTimeout(() => span.classList.add('vne-revealed'), NAME_HOLD); };
				span.addEventListener('mouseenter', () => { if (!nameLocked) hold(); });
				span.addEventListener('mouseleave', () => {
					clearTimeout(timer);
					if (!nameLocked) span.classList.remove('vne-revealed');
				});
				span.addEventListener('click', () => {
					nameLocked = !nameLocked;
					lsSet(LS_NAMELOCK, nameLocked);
					clearTimeout(timer);
					for (const s of $$('.vne-name')) {
						s.classList.toggle('vne-locked', nameLocked);
						s.classList.toggle('vne-revealed', nameLocked);
					}
					if (!nameLocked) hold(); // pointer is still on it, re-run the hold instead of stranding it blurred
				});
				p.replaceChild(span, node);
				if (/\s$/.test(node.textContent)) p.insertBefore(document.createTextNode(' '), span.nextSibling);
			}
		}
	}
	function hookCensorName() {
		const head = $('.PageHeader');
		if (!head) return;
		censorName();
		const obs = new MutationObserver(() => {
			obs.disconnect();
			try { censorName(); } finally { obs.observe(head, { childList: true, subtree: true }); }
		});
		obs.observe(head, { childList: true, subtree: true });
	}

	// color: Yes red, Unsure amber, No green
	const VTEXT = { positive: 'Yes', skip: 'Unsure', negative: 'No' };
	const VCOLOR = { positive: '#ff5252', skip: '#e8a33d', negative: '#4caf50' };

	// ---------------- fullscreen hud ----------------
	// the verdict column is not on screen in fullscreen, so without this the only
	// way to answer is to drop out of the video and back in for every clip
	const QLABEL = { aimassist: 'aim assist', wallhack: 'wall hack', autobhop: 'auto bhop', bot: 'bot' };
	const VORDER = ['positive', 'skip', 'negative'];

	function buildHud() {
		const host = $('.video-js');
		if (!host) return;
		const hud = document.createElement('div');
		hud.id = 'vne-hud';
		hud.innerHTML = QUESTIONS.map((q, i) => `
			<div class="vne-hud-row" data-q="${q}">
				<span class="vne-hud-q">${i + 1} ${QLABEL[q]}</span>
				${VORDER.map(v => `<button class="vne-hud-b" data-v="${v}" style="--c:${VCOLOR[v]}">${VTEXT[v]}</button>`).join('')}
			</div>`).join('')
			+ `<div class="vne-hud-actions">
				<button class="vne-btn" id="vne-hud-back" title="backspace">back</button>
				<button class="vne-btn" id="vne-hud-go" title="enter">proceed</button>
			</div>`;
		host.appendChild(hud);
		ui.hud = hud;

		for (const b of hud.querySelectorAll('.vne-hud-b')) {
			b.onclick = () => {
				if (inConfirm()) return; // the radios are gone, nothing to set
				setVerdict(b.closest('.vne-hud-row').dataset.q, b.dataset.v);
				renderHud();
			};
		}
		$('#vne-hud-go').onclick = proceed;
		$('#vne-hud-back').onclick = back;
		player.on('fullscreenchange', renderHud);
		renderHud();
	}

	function renderHud() {
		const hud = ui.hud;
		if (!hud) return;
		const on = player.isFullscreen();
		hud.classList.toggle('vne-show', on);
		if (!on) return;
		const confirm = inConfirm();
		hud.classList.toggle('vne-hud-locked', confirm);
		for (const rowEl of hud.querySelectorAll('.vne-hud-row')) {
			const q = rowEl.dataset.q;
			const cur = confirm
				? (confirmedChoices ? confirmedChoices[QUESTIONS.indexOf(q)] : 'skip')
				: getVerdict(q);
			for (const b of rowEl.querySelectorAll('.vne-hud-b')) {
				b.classList.toggle('vne-on', b.dataset.v === cur);
			}
		}
		$('#vne-hud-go').textContent = confirm ? 'confirm' : 'proceed';
		$('#vne-hud-back').style.display = confirm ? '' : 'none';
	}

	function inConfirm() { return !!S('backBtn'); }
	function proceed() {
		if (advancing) return;
		S('submitBtn')?.click(); // hookGuard captures the answers off this click
		renderHud();
	}
	function back() {
		confirmedChoices = null;
		S('backBtn')?.click();
		renderHud();
	}

	// ---------------- scrub thumbnails ----------------
	// decoded in a detached video element. the vod is served cross-origin so the
	// canvas ends up tainted, which is fine: the frames are only ever drawn, and
	// never read back.
	const THUMB_W = 160, THUMB_H = 90;
	let thumbs = null;

	// one canvas per second of a six minute replay is around twenty megabytes,
	// so the cache needs a ceiling; oldest out first, they are cheap to redraw
	const THUMB_CACHE_MAX = 120;
	function createThumbs(src) {
		const cache = new Map();
		const v = document.createElement('video');
		v.src = src; v.preload = 'auto'; v.muted = true; v.playsInline = true;
		let busy = false, queued = null, dead = false;

		const draw = b => {
			const c = document.createElement('canvas');
			c.width = THUMB_W; c.height = THUMB_H;
			const ctx = c.getContext('2d');
			if (!ctx) return null;
			try { ctx.drawImage(v, 0, 0, THUMB_W, THUMB_H); } catch (e) { return null; }
			cache.set(b, c);
			if (cache.size > THUMB_CACHE_MAX) cache.delete(cache.keys().next().value);
			return c;
		};
		// one decode in flight at a time, and only the newest request is kept, so
		// dragging across the bar does not queue up a hundred seeks
		const pump = () => {
			if (dead || busy || !queued) return;
			const job = queued; queued = null; busy = true;
			const done = () => {
				v.removeEventListener('seeked', done);
				busy = false;
				const f = draw(job.b);
				if (f) job.cb(f);
				pump();
			};
			v.addEventListener('seeked', done);
			try { v.currentTime = job.b; } catch (e) { v.removeEventListener('seeked', done); busy = false; }
		};

		return {
			request(sec, cb) {
				if (dead) return;
				const b = Math.round(sec); // one frame per second is enough to scrub by
				const hit = cache.get(b);
				if (hit) return void cb(hit);
				queued = { b, cb };
				pump();
			},
			dispose() { dead = true; queued = null; v.removeAttribute('src'); v.load(); cache.clear(); },
		};
	}

	function applyThumbSetting() {
		if (CFG.thumbnails) {
			if (!thumbs && vid?.currentSrc) thumbs = createThumbs(vid.currentSrc);
		} else {
			thumbs?.dispose();
			thumbs = null;
			ui.thumb?.classList.remove('vne-show');
		}
	}

	function buildThumbs() {
		const holder = S('progress');
		const host = $('.video-js');
		if (!holder || !host) return;
		const box = document.createElement('div');
		box.id = 'vne-thumb';
		box.innerHTML = '<div id="vne-thumb-img"></div><div id="vne-thumb-time"></div>';
		host.appendChild(box);
		ui.thumb = box;

		holder.addEventListener('mousemove', e => {
			if (!CFG.thumbnails) return;
			const dur = vid?.duration;
			if (!dur || !isFinite(dur)) return;
			if (!thumbs) applyThumbSetting();
			if (!thumbs) return;
			const r = holder.getBoundingClientRect(), hr = host.getBoundingClientRect();
			const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
			const t = frac * dur;
			$('#vne-thumb-time').textContent = fmt(t);
			// clamped to the player so the box never hangs off the edge
			box.style.left = clamp(e.clientX - hr.left, THUMB_W / 2 + 4, hr.width - THUMB_W / 2 - 4) + 'px';
			box.classList.add('vne-show');
			thumbs.request(t, c => $('#vne-thumb-img').replaceChildren(c));
		});
		holder.addEventListener('mouseleave', () => box.classList.remove('vne-show'));
		applyThumbSetting();
	}

	// ---------------- settings ----------------
	const SET_NUMS = [
		['seekSmall', 'small seek (arrows)', 1, 60, 1],
		['seekBig', 'large seek (j / l)', 1, 120, 1],
		['contextNear', 'near context before clip (e)', 1, 120, 1],
		['contextFar', 'far context before clip (shift+e)', 5, 300, 5],
		['slowmoLead', 'slow-mo lead-in (b)', 0, 10, 0.5],
		['slowmoRate', 'slow-mo rate (b)', 0.1, 1, 0.05],
		['rateStep', 'rate step (- / =)', 0.05, 1, 0.05],
		['holdRate', 'hold-space rate', 1, 8, 0.25],
		['rateMin', 'slowest rate', 0.1, 1, 0.05],
		['rateMax', 'fastest rate', 1, 8, 0.25],
		['fps', 'fps fallback for frame step', 24, 240, 1],
		['historyMax', 'history cap', 100, 20000, 100],
	];
	const SET_TOGGLES = [
		['coverageGuard', 'warn on confirm if i never played the flagged moment'],
		['thumbnails', 'preview frames when scrubbing the seek bar'],
		['inPlace', 'swap the next clip in instead of reloading the page'],
	];

	function saveSettings() { lsSet('vneSettings', CFG); }
	function setSetting(k, v) {
		if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) return;
		Object.assign(CFG, mergeSettings(Object.assign({}, CFG, { [k]: v })));
		saveSettings();
		if (k === 'thumbnails') applyThumbSetting();
		renderSettings();
	}

	function buildSettings() {
		const ov = document.createElement('div');
		ov.id = 'vne-set';
		ov.innerHTML = `
			<div id="vne-set-box">
				<div id="vne-set-top">
					<h2 id="vne-set-title">Settings</h2>
					<button class="vne-btn" id="vne-set-close" title="esc" aria-label="close settings">✕</button>
				</div>
				<div id="vne-set-body"></div>
			</div>`;
		document.body.appendChild(ov);
		setupDialog(ov, 'vne-set-title');
		$('#vne-set-close').onclick = toggleSettings;
		ov.onclick = e => { if (e.target === ov) toggleSettings(); };
		renderSettings();
	}

	function renderSettings() {
		const body = $('#vne-set-body');
		if (!body) return;
		// bound with for/id: without it the label is a dead target and the control
		// has no accessible name
		const nums = SET_NUMS.map(([k, label, min, max, step]) =>
			`<div class="vne-set-row"><label for="vne-set-${k}">${label}</label><input id="vne-set-${k}" type="number" inputmode="decimal" data-k="${k}" value="${CFG[k]}" min="${min}" max="${max}" step="${step}"></div>`).join('');
		const toggles = SET_TOGGLES.map(([k, label]) =>
			`<div class="vne-set-row"><label for="vne-set-${k}">${label}</label><input id="vne-set-${k}" type="checkbox" data-t="${k}"${CFG[k] ? ' checked' : ''}></div>`).join('');
		const hooks = probe().map(h => {
			const state = h.found ? 'ok' : h.tr ? 'not on this step' : h.req ? 'MISSING (required)' : 'missing';
			const cls = h.found || h.tr ? 'vne-ok' : h.req ? 'vne-miss-req' : 'vne-miss';
			return `<div class="vne-set-hook" title="${h.note}"><span class="vne-mono">${h.sel}</span><span class="${cls}">${state}</span></div>`;
		}).join('');
		body.innerHTML = `
			<h3>amounts</h3>${nums}
			<h3>behaviour</h3>${toggles}
			<h3>page hooks</h3>
			<div class="vne-set-note">the portal is unversioned html. if a feature disappears, the hook it needed shows up broken here.</div>
			${hooks}
			<div class="vne-set-row"><button class="vne-btn" id="vne-set-reset">reset everything to defaults</button></div>`;

		for (const inp of $$('#vne-set-body input[data-k]')) {
			inp.onchange = () => {
				const v = parseFloat(inp.value);
				if (isFinite(v)) setSetting(inp.dataset.k, v);
			};
		}
		for (const inp of $$('#vne-set-body input[data-t]')) {
			inp.onchange = () => setSetting(inp.dataset.t, inp.checked);
		}
		$('#vne-set-reset').onclick = () => {
			Object.assign(CFG, mergeSettings(null));
			saveSettings();
			applyThumbSetting();
			renderSettings();
		};
	}

	function toggleSettings() {
		const ov = $('#vne-set');
		if (!ov) return;
		const show = !dialogOpen(ov);
		if (show) renderSettings();
		showDialog(ov, show);
	}

	function buildHistoryPanel() {
		const box = document.createElement('div');
		box.id = 'vne-history';
		S('form').parentNode.appendChild(box);
		renderHistoryPanel();
	}

	// the same moment re-served under a new task id is much stronger evidence
	// than a different moment of the same match, so the two are never mixed
	function renderHistoryPanel() {
		const box = $('#vne-history');
		if (!box) return;
		const vodKey = vodId(), key = clipKey();
		const all = history().concat(shared())
			.filter(h => h.vod === vodKey)
			.sort((a, b) => (b.ts || 0) - (a.ts || 0));
		const exact = all.filter(h => entryKey(h) === key);
		const other = all.filter(h => entryKey(h) !== key);
		const seen = exact.concat(other); // data-i indexes into this

		const row = (h, i) => {
			const sum = labelSummary(h.labels);
			const ago = Math.round((Date.now() - h.ts) / 3600000);
			const canApply = (h.labels || []).some(l => /^(guilty|innocent|skip)_/.test(l));
			const cov = h.eventWatched === false ? ' <span class="vne-unseen" title="the flagged moment was never played on that pass">event unseen</span>' : '';
			return `<div class="vne-hrow${canApply ? ' vne-apply' : ''}" data-i="${i}"${canApply ? ' title="click to fill in this verdict"' : ''}><span class="vne-hlabels ${sum.cls}">${esc(sum.txt)}</span><span>${fmt(h.start)} → ${fmt(h.end)}</span><span>${ago < 1 ? '<1h' : ago + 'h'} ago · #${esc(h.task)}${h.by ? ` · <span class="vne-by">${esc(h.by)}</span>` : ''}${cov}</span></div>`;
		};

		let html = '';
		if (exact.length) {
			html += `<h4>This exact clip, labelled ${exact.length} time${exact.length > 1 ? 's' : ''} before</h4>`
				+ exact.slice(0, 8).map((h, i) => row(h, i)).join('');
		}
		if (other.length) {
			html += `<h4 class="${exact.length ? 'vne-h4-sub' : ''}">Same replay, ${other.length} other moment${other.length > 1 ? 's' : ''}</h4>`
				+ `<div class="vne-hnote">a different moment of this match. weaker evidence than the same clip.</div>`
				+ other.slice(0, 8).map((h, i) => row(h, exact.length + i)).join('');
		}
		if (!seen.length) html = `<h4>New replay</h4><div>${history().length} clips in local history</div>`;
		box.innerHTML = html;

		for (const el of box.querySelectorAll('.vne-hrow.vne-apply')) {
			el.onclick = () => {
				applyLabels(seen[+el.dataset.i].labels);
				el.style.background = '#4caf5033';
				setTimeout(() => el.style.background = '', 400);
			};
		}
	}

	let archFilter = { q: '', kind: 'all' };
	function buildArchive() {
		const ov = document.createElement('div');
		ov.id = 'vne-arch';
		ov.innerHTML = `
			<div id="vne-arch-top">
				<h2 id="vne-arch-title">Labelling History</h2>
				<label class="vne-sr" for="vne-arch-q">Filter history</label>
				<input id="vne-arch-q" type="search" name="filter" placeholder="filter by task, vod or match, e.g. 1734247…" autocomplete="off" spellcheck="false">
				<button class="vne-btn vne-filter-on" data-kind="all">all</button>
				<button class="vne-btn" data-kind="clean">clean</button>
				<button class="vne-btn" data-kind="uncertain">uncertain</button>
				<button class="vne-btn" data-kind="guilty">guilty</button>
				<button class="vne-btn" id="vne-arch-json">export json</button>
				<button class="vne-btn" id="vne-arch-csv">export csv</button>
				<button class="vne-btn" id="vne-arch-share" title="export your labels with your name, for a mate to import">share</button>
				<button class="vne-btn" id="vne-arch-import" title="import a mate's share file">import</button>
				<input type="file" id="vne-import-file" accept=".json,application/json" style="display:none">
				<button class="vne-btn" id="vne-arch-close" title="esc" aria-label="close history">✕</button>
			</div>
			<div id="vne-arch-stats"></div>
			<div id="vne-arch-body"></div>`;
		document.body.appendChild(ov);
		setupDialog(ov, 'vne-arch-title');
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
		// summarising is not free and this runs for every row, twice over
		const kindOf = h => {
			const txt = labelSummary(h.labels).txt;
			if (txt === 'clean') return 'clean';
			if (txt === 'uncertain') return 'uncertain';
			return labelList(h.labels).some(l => l.startsWith('guilty')) ? 'guilty' : 'other';
		};
		const kinds = new Map(all.map(h => [h, kindOf(h)]));
		const list = all.filter(h => {
			if (archFilter.kind !== 'all' && kinds.get(h) !== archFilter.kind) return false;
			if (!archFilter.q) return true;
			return [h.task, h.vod, h.match, h.by].some(v => String(v || '').toLowerCase().includes(archFilter.q));
		});
		const counts = { clean: 0, uncertain: 0, guilty: 0, other: 0 };
		for (const h of all) counts[kinds.get(h)]++;
		const imported = shared().length;
		$('#vne-arch-stats').setAttribute('aria-live', 'polite');
		$('#vne-arch-stats').textContent =
			`${all.length - imported} labelled · ${counts.clean} clean · ${counts.uncertain} uncertain · ${counts.guilty} guilty` +
			(counts.other ? ` · ${counts.other} other` : '') +
			(imported ? ` · ${imported} imported` : '') +
			(list.length !== all.length ? ` · showing ${list.length}` : '');
		const pad = n => String(n).padStart(2, '0');
		const when = ts => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
		const CAP = 500;
		const rows = list.slice(0, CAP).map(h => {
			const view = safeUrl(h.view), vod = safeUrl(h.vodUrl);
			return `<tr>
				<td>${when(h.ts)}</td>
				<td>${view ? `<a href="${esc(view)}" target="_blank" rel="noreferrer noopener">#${esc(h.task)}</a>` : '#' + esc(h.task || '?')}</td>
				<td class="vne-mono">${esc(h.vod)}</td>
				<td>${fmt(h.start)} → ${fmt(h.end)}</td>
				<td>${labelDetail(h.labels)}</td>
				<td class="vne-by">${esc(h.by)}</td>
				<td>${h.match ? `<span class="vne-copy vne-mono" data-copy="${esc(h.match)}" title="click to copy">${esc(h.match)}</span>` : ''}</td>
				<td>${vod ? `<a href="${esc(vod)}" target="_blank" rel="noreferrer noopener">vod</a>` : ''}</td>
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
		if (!ov) return;
		const show = !dialogOpen(ov);
		if (show) renderArchive();
		showDialog(ov, show);
	}

	function buildKeymapOverlay() {
		const km = document.createElement('div');
		km.id = 'vne-keymap';
		km.setAttribute('aria-label', 'keyboard shortcuts');
		km.innerHTML =
`<b>player</b>
space      tap play/pause, hold 2x
k          play/pause     m  mute
← →        ±${CFG.seekSmall}s            j l  ±${CFG.seekBig}s
, .        frame step (pauses)
- =        rate down/up   f  fullscreen
c          clip start     v  event
b          slow-mo event  e  run-up (shift+e further)
g          clip loop      d  open vod
a          history        esc  close overlays

<b>verdicts</b> (1 aim, 2 wh, 3 bhop, 4 bot)
1-4        toggle No / Unsure
shift+1-4  Yes
z LEGIT  q AIM  h WH  r RAGE  x reset
enter      proceed / confirm
backspace  back
?          this help`;
		document.body.appendChild(km);
		setupDialog(km, null);
	}

	// ---------------- render ----------------
	function renderTick() {
		if (!vid) return;
		const t = vid.currentTime;
		if (!vid.paused) coverage.mark(t);
		ui.play.textContent = vid.paused ? '▶' : '⏸';
		renderRateSelect();
		renderHud();
		if (clip.ok) {
			const len = clip.end - clip.start;
			const frac = clamp((t - clip.start) / len, 0, 1);
			ui.clipFill.style.width = (frac * 100) + '%';
			ui.clipHead.style.left = `calc(${frac * 100}% - 1px)`;
			ui.clipEvent.style.left = (clamp((clip.event - clip.start) / len, 0, 1) * 100) + '%';
			const inClip = t >= clip.start - 0.05 && t <= clip.end + 0.001;
			const watched = Math.round(coverage.fraction() * 100);
			const evSeen = coverage.watchedAt(clip.event);
			if (evSeen !== announcedEventSeen) {
				announcedEventSeen = evSeen;
				if (evSeen) announce('flagged moment watched');
			}
			ui.time.innerHTML = `${fmt(t)} / ${fmt(vid.duration)} · clip <b>${inClip ? fmt(clamp(t - clip.start, 0, len)) : '-'}</b> / ${fmt(len)}`
				+ ` · watched <b class="${evSeen ? '' : 'vne-unseen'}">${watched}%</b>${evSeen ? '' : ' <span class="vne-unseen" title="you have not played through the flagged moment">event unseen</span>'}`;
			if (ui.outclip) ui.outclip.classList.toggle('vne-show', !inClip && !clipLock);
			if (clipLock) {
				if (t >= clip.end || t < clip.start - 0.05) seekTo(clip.start);
			} else if (clipLoop && t >= clip.end) {
				seekTo(clip.start);
			}
		} else {
			ui.time.textContent = `${fmt(t)} / ${fmt(vid.duration)}`;
		}
	}

	// the old control cycled up in steps and wrapped round to 1x, so reaching 0.5
	// meant going the long way. the list is filtered to the configured bounds.
	const RATES = [0.1, 0.25, 0.5, 1, 2, 4];
	function renderRateSelect() {
		const sel = ui.rate;
		if (!sel) return;
		const cur = Math.round(player.playbackRate() * 100) / 100;
		const list = RATES.filter(r => r >= CFG.rateMin - 1e-9 && r <= CFG.rateMax + 1e-9);
		// - / = step off the list, so whatever it lands on gets its own entry
		if (!list.some(r => Math.abs(r - cur) < 1e-9)) list.push(cur);
		list.sort((a, b) => a - b);
		const key = list.join(',');
		// only rebuild when the list really changes, otherwise an open dropdown
		// would close itself on every render tick
		if (sel.dataset.built !== key) {
			sel.innerHTML = list.map(r => `<option value="${r}">${r}x</option>`).join('');
			sel.dataset.built = key;
		}
		sel.value = String(cur);
	}

	// ---------------- player actions ----------------
	function seekTo(t) { if (clipLock && clip.ok) t = clamp(t, clip.start, clip.end); player.currentTime(clamp(t, 0, vid.duration || 1e9)); }
	function seekBy(d) { seekTo(vid.currentTime + d); }
	function togglePlay() { vid.paused ? player.play() : player.pause(); }
	function setRate(r) { slowmoActive = false; player.playbackRate(clamp(Math.round(r * 100) / 100, CFG.rateMin, CFG.rateMax)); renderTick(); }
	function frameStep(dir) { player.pause(); seekBy(dir / CFG.fps); }
	function toggleFullscreen() { player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen(); }
	// replay the flagged moment slowly. the lead-in matters: dropping in exactly
	// on the event means the frames that explain it have already gone past
	function slowmoEvent() {
		if (!clip.ok) return;
		seekTo(Math.max(0, clip.event - CFG.slowmoLead));
		setRate(CFG.slowmoRate);
		slowmoActive = true; // after setRate, which hands ownership to its caller
		player.play();
	}

	// slow-mo is a replay of one moment, not a mode. jumping somewhere else to
	// watch it normally ends it. setting a rate yourself also ends it, because
	// from then on the rate is yours rather than slow-mo's.
	function endSlowmo() {
		if (!slowmoActive) return;
		setRate(1); // clears the flag on its way through
	}
	// start before the clip so the run-up is visible. this is the whole point of
	// removing the clamp, so it gets its own keys rather than manual scrubbing
	function seekContext(sec) {
		if (!clip.ok) return;
		endSlowmo();
		if (clipLock) return void console.warn('[vne] clip lock is on, run-up seek ignored');
		seekTo(Math.max(0, clip.start - sec));
		player.play();
	}
	function toggleLoop() {
		clipLoop = !clipLoop;
		ui.loop.classList.toggle('vne-on', clipLoop);
	}
	function enforceClipLock() {
		if (!clip.ok || !vid) return;
		const t = vid.currentTime;
		if (t < clip.start || t > clip.end) seekTo(clip.start);
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
		const p = PRESETS[name];
		if (!p) return;
		QUESTIONS.forEach((q, i) => setVerdict(q, p[i]));
	}
	// rename verdict buttons to Yes / Unsure / No, portal regenerates them so observe + reapply
	// color: Yes red, Unsure amber, No green
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
	// every text-ish input, not just type=text: the archive filter is type=search
	// now, and a missed case here means shortcuts fire while you are typing
	function isTypingTarget(a) {
		if (!a) return false;
		if (a.isContentEditable) return true;
		const tag = a.tagName;
		if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
		if (tag !== 'INPUT') return false;
		const t = a.type;
		return t !== 'radio' && t !== 'checkbox' && t !== 'button' && t !== 'submit';
	}

	function hookKeys() {
		document.addEventListener('keydown', e => {
			const a = document.activeElement;
			// escape first and unconditionally, so it still closes an overlay from
			// inside its own filter box
			if (e.key === 'Escape') {
				// swallowing it with nothing open would take escape away from the
				// page and the browser for no reason
				if (closeOverlays()) {
					e.preventDefault();
					e.stopPropagation();
				}
				return;
			}
			if (isTypingTarget(a)) return;
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
				case 'c': case 'C': endSlowmo(); seekTo(clip.start); break;
				case 'v': case 'V': endSlowmo(); seekTo(clip.event - 2); break;
				case 'b': case 'B': slowmoEvent(); break;
				case 'e': case 'E': seekContext(e.shiftKey ? CFG.contextFar : CFG.contextNear); break;
				case 'g': case 'G': toggleLoop(); break;
				case 'd': case 'D': { const u = safeUrl(clip.vodUrl || vid.currentSrc); if (u) window.open(u, '_blank', 'noreferrer'); break; }
				case 'a': case 'A': toggleArchive(); break;
				case 's': case 'S': toggleSettings(); break;
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
				case 'q': case 'Q': applyPreset('AIM'); break;
				case 'h': case 'H': applyPreset('WH'); break;
				case 'r': case 'R': applyPreset('RAGE'); break;
				case 'x': case 'X': QUESTIONS.forEach(q => setVerdict(q, 'skip')); break;
				case 'Enter': {
					if (a && a.tagName === 'BUTTON') a.blur();
					proceed();
					break;
				}
				case 'Backspace': back(); break;
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

	function toggleKeymap() {
		const ov = $('#vne-keymap');
		if (ov) showDialog(ov, !dialogOpen(ov));
	}

	// ---------------- history ----------------
	function vodId() {
		const src = clip.vodUrl || vid?.currentSrc || '';
		const m = src.match(/_([0-9a-f]{16})[0-9a-f]*\.webm/); // 16 hex prefix enough, vods are csow_/cl_ + 64 hex
		return m ? m[1] : src.split('/').pop();
	}
	function history() { return lsGet(LS_HISTORY, []); }
	function shared() { return lsGet(LS_SHARED, []); }
	function exportShare() {
		const name = window.prompt('name to attach to your labels', lsGet(LS_NAME, ''));
		if (name === null) return;
		// this lands in a filename, so keep it to characters a filename can hold
		const n = name.trim().slice(0, 40).replace(/[^0-9A-Za-z _-]/g, '') || 'anonymous';
		lsSet(LS_NAME, n);
		const sh = shared();
		const withGroup = sh.length > 0 && window.confirm(`include ${sh.length} imported labels from others?\nok = full group dataset with everyone's names, cancel = just yours`);
		const verdicts = withGroup ? history().concat(sh) : history();
		dl(`vacnet-labels-${n}${withGroup ? '-group' : ''}.json`, JSON.stringify({ vne: 2, name: n, exported: Date.now(), verdicts }, null, 1), 'application/json');
	}
	// an imported file is json somebody else wrote. rather than storing it and
	// trusting the render step to cope, every entry is rebuilt here from only the
	// fields that get used, as the types they are meant to be. anything else in
	// the file is dropped before it is ever stored.
	const LABEL_RE = /^[a-z]{3,12}_[a-z]{2,20}$/;
	function sanitizeEntry(v, fallbackBy) {
		if (!v || typeof v !== 'object') return null;
		const str = (x, max) => String(x == null ? '' : x).trim().slice(0, max);
		// an id that is not shaped like an id is dropped rather than carried
		// around and rendered; it also keeps the clipboard copy predictable
		const id = (x, re, max) => { const v = str(x, max); return re.test(v) ? v : ''; };
		const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
		const labels = (Array.isArray(v.labels) ? v.labels : [])
			.filter(l => typeof l === 'string' && LABEL_RE.test(l)).slice(0, 12);
		const task = id(v.task, /^[0-9A-Za-z_-]{1,40}$/, 40);
		if (!task || !labels.length) return null;
		const by = str(v.by, 40) || fallbackBy;
		return {
			task, by,
			key: id(v.key, /^[0-9A-Za-z_.:-]{0,90}$/, 90),
			vod: id(v.vod, /^[0-9A-Za-z_-]{0,90}$/, 90),
			vodUrl: safeUrl(v.vodUrl), view: safeUrl(v.view),
			match: id(v.match, /^[0-9A-Za-z_-]{0,40}$/, 40),
			start: num(v.start), end: num(v.end), event: num(v.event),
			labels,
			coverage: num(v.coverage), eventWatched: v.eventWatched === true,
			ts: num(v.ts) || Date.now(),
		};
	}

	const IMPORT_MAX_BYTES = 32 * 1024 * 1024;
	function importShare(file) {
		if (file.size > IMPORT_MAX_BYTES) {
			window.alert('That file is over 32 MB, which is far larger than any labels export. Check you picked the right file.');
			return;
		}
		file.text().then(txt => {
			let obj;
			try { obj = JSON.parse(txt); } catch (e) {
				window.alert('That file is not valid JSON, so it may be truncated or edited. Ask for a fresh copy exported with share.');
				return;
			}
			const verdicts = Array.isArray(obj) ? obj : obj?.verdicts;
			if (!Array.isArray(verdicts)) {
				window.alert('That JSON is not a labels export. Use a file made by share in the archive, not an export from somewhere else.');
				return;
			}
			let by = String(obj?.name || '').trim().slice(0, 40);
			if (!by) by = (window.prompt('whose labels are these?') || '').trim().slice(0, 40) || 'unknown';
			const ownTasks = new Set(history().map(h => String(h.task)));
			const sh = shared();
			const seen = new Set(sh.map(h => h.by + '|' + h.task));
			let added = 0, skipped = 0;
			for (const raw of verdicts.slice(0, 50000)) {
				const v = sanitizeEntry(raw, by); // group exports carry per-entry names, keep them
				if (!v) { skipped++; continue; }
				const key = v.by + '|' + v.task;
				if (ownTasks.has(v.task) || seen.has(key)) { skipped++; continue; }
				seen.add(key);
				sh.push(v);
				added++;
			}
			if (sh.length > 20000) sh.splice(0, sh.length - 20000);
			lsSet(LS_SHARED, sh);
			renderArchive();
			window.alert(added
				? `Imported ${added} labels from ${by}. Skipped ${skipped} already held or not readable.`
				: `Nothing imported from ${by}. All ${skipped} entries were already held or could not be read.`);
		}, () => window.alert('Could not read that file. Check it still exists and try picking it again.'));
	}
	// records can come from an imported file, so nothing here may assume the
	// entries are strings, or a single bad one takes the whole panel down
	function labelList(labels) {
		return Array.isArray(labels) ? labels.filter(l => typeof l === 'string') : [];
	}
	function labelSummary(labels) {
		const ls = labelList(labels);
		if (!ls.length) return { cls: '', txt: '?' };
		if (ls.includes('tag_badclip')) return { cls: '', txt: 'bad clip' };
		if (ls.every(l => l.startsWith('innocent'))) return { cls: 'vne-clean', txt: 'clean' };
		if (ls.every(l => l.startsWith('skip'))) return { cls: '', txt: 'uncertain' };
		const g = ls.filter(l => l.startsWith('guilty')).map(l => l.slice(7));
		return g.length ? { cls: 'vne-guilty', txt: g.join('+') } : { cls: '', txt: 'mixed' };
	}
	const Q_SHORT = { aimassist: 'aim', wallhack: 'wh', autobhop: 'bhop', bot: 'bot' };
	function labelDetail(labels) {
		const ls = labelList(labels);
		if (!ls.length) return '?';
		if (ls.includes('tag_badclip')) return 'bad clip';
		return ls.map(l => {
			const m = l.match(/^(guilty|innocent|skip)_(.+)$/);
			if (!m) return esc(l);
			const q = esc(Q_SHORT[m[2]] || m[2]);
			if (m[1] === 'guilty') return `<span class="vne-guilty">${q} yes</span>`;
			if (m[1] === 'innocent') return `<span class="vne-clean">${q} no</span>`;
			return `<span class="vne-skip">${q} ?</span>`;
		}).join('<span class="vne-skip"> · </span>');
	}
	function recordHistory() {
		const labels = $$('#submitverdictform input[name="verdict_labels[]"]').map(i => i.value);
		const h = history();
		h.push({
			task: task.id, key: clipKey(), vod: vodId(), vodUrl: vid?.currentSrc || '',
			view: task.viewUrl || '', match: (task.matchId && task.matchId !== 'none') ? task.matchId : '',
			start: clip.start, end: clip.end, event: clip.event, labels,
			coverage: coverage.fraction(), eventWatched: coverage.watchedAt(clip.event), ts: Date.now(),
		});
		if (h.length > CFG.historyMax) h.splice(0, h.length - CFG.historyMax);
		lsSet(LS_HISTORY, h);
	}
	// ---------------- in place advance ----------------
	let advancing = false;
	let advanceToken = 0; // a late timer from an earlier swap must not touch a newer one

	function hookSubmit() {
		const form = S('form');
		if (!form) return;
		// both SubmitLabels and ReportBadClip end in form.submit(), which fires no
		// event. shadowing that one method catches both, and still lets the portal
		// do its own pre-submit work, which for a bad clip report is what writes
		// the label in the first place.
		const native = HTMLFormElement.prototype.submit;
		const fallback = () => native.call(form);
		Object.defineProperty(form, 'submit', {
			configurable: true,
			writable: true,
			value: () => {
				try {
					recordHistory();
					if (!CFG.inPlace) return void fallback();
					advance(fallback);
				} catch (e) {
					console.warn('[vne] submit hook failed', e);
					fallback();
				}
			},
		});
	}

	// posts the verdict form and returns the page the portal would have navigated
	// to. null means the caller has to fall back to a real navigation.
	function submitAndParse(currentTaskId) {
		const form = S('form');
		if (!form) return Promise.resolve(null);
		const action = form.getAttribute('action') || location.pathname;
		let url;
		try { url = new URL(action, location.href); } catch (e) { return Promise.resolve(null); }
		// this post carries the session cookie. if the form action ever points off
		// the portal, hand back to the browser rather than sending it there.
		if (url.origin !== location.origin) {
			console.warn('[vne] form action is off-origin, refusing to post', url.origin);
			return Promise.resolve(null);
		}
		const body = new URLSearchParams();
		for (const [k, v] of new FormData(form)) if (typeof v === 'string') body.append(k, v);
		return fetch(url.toString(), {
			method: 'POST', body, credentials: 'include', redirect: 'follow',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}).then(res => res.ok ? res.text() : null).then(text => {
			if (text === null) return null;
			const doc = new DOMParser().parseFromString(text, 'text/html');
			const c = parseClipFrom(doc), t = parseTaskFrom(doc);
			// every field has to be there and the task has to have actually moved
			// on. a half applied page would leave the form holding one task while
			// the player shows another, which is the one failure worth refusing.
			if (!c || !c.vodUrl) return null;
			if (!t.id || t.id === currentTaskId) return null;
			if (!S('form', doc)) return null;
			return { doc, clip: c, task: t };
		});
	}

	function advance(fallback) {
		if (advancing) return;
		advancing = true;
		setLoading(true);
		return submitAndParse(task.id).then(next => {
			if (!next) {
				setLoading(false);
				return void fallback();
			}
			applyNext(next);
		}).catch(e => {
			console.warn('[vne] could not advance in place', e);
			setLoading(false);
			fallback();
		}).then(() => { advancing = false; });
	}

	// everything the reviewer can act on is replaced together, so the form can
	// never be holding one task while the player shows another
	function applyNext(next) {
		clip = next.clip;
		task = next.task;
		coverage = makeCoverage(clip.start, clip.end);
		coverageWarned = false;
		announcedEventSeen = false;
		confirmedChoices = null;
		clipLoop = false;

		const ti = S('taskInput');
		if (ti) ti.value = task.id;
		for (const i of $$('#submitverdictform input[name="verdict_labels[]"]')) i.remove();

		const det = S('details'), nextDet = S('details', next.doc);
		if (det && nextDet) det.innerHTML = nextDet.innerHTML;
		const cnt = S('clipCount'), nextCnt = S('clipCount', next.doc);
		if (cnt && nextCnt) cnt.innerHTML = nextCnt.innerHTML;

		// SetModeLabeling restores the portal's own remembered answers, which
		// without a page load are the previous clip's. wipe them, or every clip
		// would arrive carrying the last verdict submitted.
		if (typeof window.SetModeLabeling === 'function') window.SetModeLabeling();
		QUESTIONS.forEach(q => setVerdict(q, 'skip'));

		updateTaskInfo();
		renderHistoryPanel();
		relabelVerdicts();
		if (ui.loop) ui.loop.classList.remove('vne-on');

		const token = ++advanceToken;
		const current = () => token === advanceToken;

		// the portal registered a loadeddata handler when the page loaded which,
		// half a second after any source finishes loading, seeks to the startTime
		// of THAT page. it is a closure constant, so on a swapped-in clip it drags
		// playback to a point from the previous one. that job is ours from here.
		// only player level listeners go, video.js forwards media events from the
		// tech and keeps working.
		player.off('loadeddata');

		player.src({ src: clip.vodUrl, type: 'video/webm' });
		// the markers and previews need the new duration, so they wait for it. the
		// confirmation waits with them: saying the next clip had arrived while the
		// loading overlay was still up contradicted itself.
		let swapped = false;
		player.one('loadedmetadata', () => {
			if (!current()) return;
			swapped = true;
			rebuildBands();
			thumbs?.dispose();
			thumbs = null;
			applyThumbSetting();
			// the portal's own jump-to-the-clip-and-play only ever ran for the page
			// it loaded with. without this the new source inherits the old playback
			// position, which is usually past the end of it, so the clip reads as
			// already finished and has to be replayed by hand.
			seekTo(clip.start);
			player.play();
			setLoading(false);
			announce(`labels submitted, next clip loaded, task ${task.id}`);
			// mirrors what the portal shows on the page it would have navigated to
			setStatus('labels submitted');
			setTimeout(() => { if (current()) setStatus(null); }, 2000);
			renderTick();
		});
		setTimeout(() => {
			if (swapped || !current()) return;
			console.warn('[vne] next clip did not report metadata, markers may be stale');
			setLoading(false);
			// the labels did submit, even though the video did not arrive
			setStatus('labels submitted, but the next clip did not load');
		}, 15000);

		renderTick();
	}

	// SubmitLabels leaves the pill up and relies on the reload to clear it.
	// advancing in place never reloads, so it has to be cleared here.
	function setStatus(text) {
		const box = S('status');
		if (!box) return;
		box.replaceChildren();
		if (text === null) return void box.classList.remove('show');
		const line = document.createElement('p');
		line.textContent = text;
		box.appendChild(line);
		box.classList.add('show');
	}

	function rebuildBands() {
		for (const el of $$('.vjs-progress-holder .vne-band, .vjs-progress-holder .vne-tick')) el.remove();
		buildProgressOverlay();
	}

	// ---------------- coverage guard ----------------
	function eventUnwatched() {
		if (!CFG.coverageGuard || coverageWarned || !clip.ok) return false;
		if (!inConfirm()) return false; // only worth asking at the last step
		if (coverage.watchedAt(clip.event)) return false;
		const choices = confirmedChoices || QUESTIONS.map(getVerdict);
		return choices.some(c => c !== 'skip'); // all uncertain asserts nothing
	}

	// bound to the buttons rather than folded into proceed(), because the portal
	// wires its own onclick on them and clicking with the mouse never goes
	// through proceed(). capture phase, so stopping here stops valve's handler.
	function hookGuard() {
		document.addEventListener('click', e => {
			if (!e.target.closest) return;
			if (e.target.closest('#backbutton')) return void (confirmedChoices = null);
			if (!e.target.closest('#submitVerdictButton')) return;
			if (!inConfirm()) {
				// last moment the answers are readable: the confirm step replaces
				// the radios with a summary
				confirmedChoices = QUESTIONS.map(getVerdict);
				return;
			}
			if (!eventUnwatched()) return;
			coverageWarned = true;
			e.preventDefault();
			e.stopPropagation();
			window.alert('You have not played through the flagged moment on this clip. Play it, or press Confirm again if you are sure.');
		}, true);
	}
})();
