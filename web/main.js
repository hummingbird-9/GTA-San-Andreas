// The page (WEB-1): checks bundled game data, launches the full-screen session, and forwards keyboard and mouse input.
// URL query: ?inworld=1 (skip the intro mission), ?backend=gl|webgpu, ?auto=1 (scripted Enter / SA_GAME_WALK, for unattended runs), any SA_* name
// (SA_GAME_STUB, SA_GAME_WALK, SA_GAME_SCRIPT_SKIP, ...) is passed to the game as a development variable.
// SA:MP is a mod: ?mods=samp[&proxy=ws://127.0.0.1:7781] (build with FEATURES=mods; docs/samp/README.md).
// ?mods=NAME,...: load these WebAssembly mods from the server's mods/ (build with FEATURES=mods).
// ?cache_mb=N: the game worker's in-memory block cache (default 256 MiB); the persistent cache (web/loader.js) is
// separate. ?io_stacks=1 logs the wasm stack of each read that waited in the world. ?download=1 starts the background download of the whole folder into the persistent cache.
// ?audiotap=1 keeps a copy of the audio output for evidence runs (window.saGame.audioTap(), tools/web/headless.mjs --audio).
// &stub=ADDR=RET/N,... replaces the default exploration stubs (the play package's, DEFAULT_STUBS); &stub=none drops them.
const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const logEl = $('log');
const statusEl = $('status');
const params = new URLSearchParams(location.search);
let worker = null;
let bundledGameFiles = null;
let selectedGameFiles = null;

// the exploration defaults of the native play package (target/play/play.sh): unported mission-script opcodes are
// skipped, and these functions return a constant (ADDRESS=RETURN/stack dwords popped; a leading ! replaces a port:
// 0x5efca0 turns off ped attractors, whose task tree is still being ported).
const DEFAULT_STUBS = '0x421a50=0/0,!0x5efca0=0/4';

if (params.get('inworld') === '1') $('inworld').checked = true;

function log(text, level = 'log') {
  const line = document.createElement('div');
  if (level === 'error') line.className = 'err';
  line.textContent = text;
  logEl.appendChild(line);
  while (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

const STATES = ['INITIAL', 'LOGO', 'PLAYING_LOGO', 'TITLE', 'PLAYING_INTRO', 'FRONTEND_LOADING', 'FRONTEND_LOADED',
  'FRONTEND_IDLE', 'LOADING_STARTED', 'IDLE', 'EXIT'];
let bootFinished = false;

function updateBootProgress(message = {}) {
  if (bootFinished) return;
  const amount = Math.max(0, Math.floor(Number(message.mib) || 0));
  $('boot-amount').textContent = `${amount.toLocaleString('en-US')} MiB READ`;
  $('boot-title').textContent = 'LOADING';
  $('boot-activity').textContent = message.preload
    ? `START-UP FILES · ${message.preload}`
    : 'LOADING GAME DATA...';
}

// Load the exact 480x300 NVIDIA badge supplied for this game splash.
// The base64 is split into small static files so it can be committed through GitHub's text-file API.
const nvidiaAssetBase = new URL(import.meta.url.includes('/web/')
  ? '../nvidia-splash/'
  : './nvidia-splash/', import.meta.url);
const nvidiaSplashReady = Promise.all(
  Array.from({ length: 4 }, (_, index) => {
    const name = `${String(index).padStart(2, '0')}.b64`;
    return fetch(new URL(name, nvidiaAssetBase)).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} loading nvidia-splash/${name}`);
      return response.text();
    });
  })
).then((parts) => {
  const base64 = parts.map((part) => part.trim()).join('');
  if (base64.length !== 28156) throw new Error(`NVIDIA splash image is incomplete (${base64.length} base64 characters)`);
  const image = $('nvidia-card');
  image.src = `data:image/webp;base64,${base64}`;
  return image.decode();
});

function showNvidiaSplash() {
  if (bootFinished) return;
  bootFinished = true;
  nvidiaSplashReady.then(() => {
    $('boot-progress').hidden = true;
    $('nvidia-splash').hidden = false;
    $('boot-overlay').hidden = false;
    $('boot-overlay').classList.add('splash');
    document.body.classList.remove('boot-loading');
    document.body.classList.add('boot-splash');
    window.setTimeout(() => {
      $('boot-overlay').hidden = true;
      $('boot-overlay').classList.remove('splash');
      document.body.classList.remove('boot-splash');
    }, 2400);
  }).catch((error) => {
    log(`NVIDIA splash image could not load: ${error}`, 'error');
    $('boot-overlay').hidden = true;
    document.body.classList.remove('boot-loading');
  });
}

window.saGame = { status: {}, logs: [], logBase: 0, snapshots: [], snapshot: () => worker?.postMessage({ type: 'snapshot' }),
  // evidence runs (tools/web/headless.mjs --teleport): the player to (x, y, z)
  teleport: (x, y, z, heading) => worker?.postMessage({ type: 'teleport', x, y, z, heading }) };

// ---------------------------------------------------------------- audio (WEB-AUDIO) ---
// The game's DirectSound mix plays through an AudioWorklet (web/audio-worklet.js). With cross-origin isolation (the
// dev server sends COOP/COEP) the worker writes a SharedArrayBuffer ring the worklet reads, and the game's play
// cursors follow the AudioContext's consumption; otherwise the worker posts chunks here and they go to the worklet's
// port. Browsers start an AudioContext only after a user gesture: the first click (the pointer-lock click) or key
// resumes it.
const RING_FRAMES = 32768; // power of two (the indices wrap at 2^32)
const audio = { ctx: null, gain: null, node: null, sab: null, mode: 'off', tapWaiters: [] };
let volume = Number(localStorage.getItem('saGameVolume') ?? '80');
let muted = localStorage.getItem('saGameMuted') === '1';

function applyVolume() {
  if (audio.gain) audio.gain.gain.value = muted ? 0 : (volume / 100) ** 2;
  $('mute').textContent = muted ? 'unmute' : 'mute';
  $('vol').value = String(volume);
}

function audioStatus() {
  const st = audio.ctx ? audio.ctx.state : 'off';
  const running = st === 'running';
  if (audio.sab) Atomics.store(new Int32Array(audio.sab, 0, 8), 2, running ? 1 : 0);
  else worker?.postMessage({ type: 'audioState', running });
  const shown = st === 'running' ? 'running' : st === 'off' ? 'off' : 'suspended (click the picture)';
  const d = audioDelay();
  $('audio').textContent = `audio: ${shown}${audio.ctx ? ` (${audio.mode}${running && d ? `, delay ${d.totalMs} ms` : ''})` : ''}`;
  $('audio').className = running ? 'on' : 'off';
  window.saGame.audio = { state: st, mode: audio.mode, ...d };
}

// end-to-end delay of a sound the game starts now: the frames queued in the ring (mixed, not yet played) plus the
// context's own latency (baseLatency: the worklet quantum / graph; outputLatency: the device)
function audioDelay() {
  if (!audio.ctx || !audio.sab) return null;
  const h = new Int32Array(audio.sab, 0, 8);
  const ringMs = (((Atomics.load(h, 0) - Atomics.load(h, 1)) | 0) / 44.1);
  const baseMs = (audio.ctx.baseLatency ?? 0) * 1000;
  const outMs = (audio.ctx.outputLatency ?? 0) * 1000;
  return { ringMs: Math.round(ringMs), targetMs: Math.round(Atomics.load(h, 4) / 44.1), baseMs: Math.round(baseMs),
    outputMs: Math.round(outMs), totalMs: Math.round(ringMs + baseMs + outMs), underruns: Atomics.load(h, 3) };
}
setInterval(() => { if (audio.ctx) audioStatus(); }, 1000);

// called at start: the context starts suspended unless the browser allows autoplay
async function initAudio() {
  try {
    audio.ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
  } catch (e) {
    log(`audio: no AudioContext (${e})`, 'error');
    return null;
  }
  audio.ctx.onstatechange = audioStatus;
  try {
    await audio.ctx.audioWorklet.addModule('audio-worklet.js');
  } catch (e) {
    log(`audio: the worklet did not load (${e})`, 'error');
    audio.ctx = null;
    return null;
  }
  let opts = {};
  if (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
    audio.sab = new SharedArrayBuffer(32 + RING_FRAMES * 4);
    opts = { sab: audio.sab };
    audio.mode = 'shared ring';
  } else {
    audio.mode = 'postMessage';
  }
  audio.node = new AudioWorkletNode(audio.ctx, 'sa-game-audio', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: opts });
  audio.gain = audio.ctx.createGain();
  audio.node.connect(audio.gain).connect(audio.ctx.destination);
  applyVolume();
  audioStatus();
  return audio.sab ? { sab: audio.sab } : { port: true };
}

function resumeAudio() {
  if (audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume().then(audioStatus, () => {});
}
window.addEventListener('pointerdown', resumeAudio, true);
window.addEventListener('keydown', resumeAudio, true);
$('mute').onclick = () => {
  muted = !muted;
  localStorage.setItem('saGameMuted', muted ? '1' : '0');
  applyVolume();
};
$('vol').oninput = () => {
  volume = Number($('vol').value);
  localStorage.setItem('saGameVolume', String(volume));
  applyVolume();
};
applyVolume();

// ---------------------------------------------------------------- the loader (RENDER-2 R2a) ---
// A served folder is fetched by web/loader.js (asynchronous ranged requests, the browser's persistent cache); the
// game's worker talks to it over a MessageChannel. Its cache status goes to the bar.
let loader = null;
function mib(n) {
  return n >= 10 * 1048576 ? `${Math.round(n / 1048576)} MiB` : `${(n / 1048576).toFixed(1)} MiB`;
}
// With cross-origin isolation (a secure context: localhost or https, and the COOP/COEP headers serve.py sends) the
// game's synchronous reads ask the loader through shared memory (SYNC_MAX bytes at a time) and wait with Atomics, so
// they are served from the persistent cache too; without it they fall back to a synchronous request.
const SYNC_MAX = 4 << 20;
let ioSab = null;
function startLoader(files) {
  loader = new Worker('loader.js');
  ioSab = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(16 + SYNC_MAX) : null;
  const ch = new MessageChannel();
  loader.onmessage = (ev) => {
    const m = ev.data;
    if (m.type !== 'cache') return;
    window.saGame.cache = m;
    const pct = m.total ? ((100 * m.cached) / m.total).toFixed(1) : '0';
    $('cache').hidden = false;
    $('cachestatus').textContent = `cache (${m.store}): ${mib(m.cached)} of ${mib(m.total)} (${pct}%) on this device, ` +
      `${mib(m.net)} downloaded this session${m.flight ? `, ${m.flight} requests in flight` : ''}` +
      `${m.storeError ? `; not kept: ${m.storeError}` : ''}`;
    $('download').textContent = m.downloadAll ? 'Stop downloading' : m.cached >= m.total ? 'All files cached' : 'Download everything (offline cache)';
    $('download').disabled = !m.downloadAll && m.cached >= m.total;
    downloading = m.downloadAll;
  };
  loader.onerror = (e) => log(`loader error: ${e.message}`, 'error');
  loader.postMessage({ type: 'init', files: files.map(({ path, size, mtime, revision, url, parts }) => ({ path, size, mtime, revision, url, parts })), port: ch.port1, sab: ioSab }, [ch.port1]);
  if (params.get('download') === '1') loader.postMessage({ type: 'downloadAll', on: true });
  return ch.port2;
}
let downloading = false;
$('download').onclick = () => loader?.postMessage({ type: 'downloadAll', on: !downloading });

async function start(files) {
  if (worker) return;
  const loaderPort = files.some((f) => f.url) ? startLoader(files) : null;
  worker = new Worker('worker.js', { type: 'module' });
  // evidence runs (?audiotap=1): the PCM produced since the last call, as base64 little-endian 16-bit stereo
  window.saGame.audioTap = () => new Promise((res) => {
    audio.tapWaiters.push(res);
    worker.postMessage({ type: 'audioTap' });
  });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'pcm') {
      audio.node?.port.postMessage(m.pcm, [m.pcm.buffer]);
    } else if (m.type === 'audioTap') {
      const bytes = new Uint8Array(m.pcm.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      audio.tapWaiters.shift()?.({ pcm: btoa(bin), underruns: m.underruns, state: m.state, ctx: audio.ctx?.state ?? 'off' });
    } else if (m.type === 'logs') {
      for (const l of m.lines) {
        log(l.text, l.level);
        window.saGame.logs.push(l.text);
      }
      const extra = window.saGame.logs.length - 4000;
      if (extra > 0) {
        window.saGame.logs.splice(0, extra);
        window.saGame.logBase += extra;
      }
    } else if (m.type === 'panic') {
      log(m.message, 'error');
      window.saGame.logs.push(m.message);
      window.saGame.panic = m.message;
      statusEl.textContent = m.message.split('\n')[0];
      statusEl.className = 'err';
    } else if (m.type === 'snapshot') {
      const bytes = new Uint8Array(m.png);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      window.saGame.snapshots.push({ state: m.state, iterations: m.iterations, png: b64 });
    } else if (m.type === 'progress') {
      window.saGame.progress = m;
      updateBootProgress(m);
      const progressText = m.preload ? `fetching start-up files · ${m.preload}` : `loading · ${m.mib} MiB read`;
      statusEl.textContent = progressText;
      $('ministatus').textContent = progressText;
    } else if (m.type === 'status') {
      window.saGame.status = m;
      if (m.client && (m.client[0] !== client[0] || m.client[1] !== client[1])) {
        client = m.client;
        document.documentElement.style.setProperty('--aspect', String(client[0] / client[1]));
      }
      const st = STATES[m.state] ?? m.state;
      updateBootProgress(m);
      if (m.error) {
        $('boot-title').textContent = 'LOAD ERROR';
        $('boot-amount').textContent = 'CHECK ENGINE LOG';
        $('boot-activity').textContent = String(m.error).slice(0, 120);
      }
      if (!bootFinished && Number(m.state) === 9 && Number(m.presents) > 0) showNvidiaSplash();
      statusEl.textContent = m.error ? `error: ${m.error}` : m.done ? m.done :
        `${m.phase ?? ''} gGameState ${st}, ${m.iterations} iterations${m.blocked ? ` (${m.blocked} blocked)` : ''}, ${m.presents} in-game frames, ${m.mib} MiB read` +
        (m.io?.waits ? `, ${m.io.waits} reads waited for the network (${m.io.waitMs} ms)` : '');
      statusEl.className = m.error ? 'err' : '';
      $('ministatus').textContent = m.error ? `Error · ${m.error}` : m.done ? m.done :
        `${st}${m.blocked ? ` · ${m.blocked} blocked` : ''}`;
      // the SA:MP UI's cursor (dialogs, scoreboard, class-selection panel) takes the pointer like the menus
      const wasMenu = inMenu;
      inMenu = m.inMenu ?? (m.state !== 9 || !!m.uiCursor || !!m.menuActive);
      // back in game from a menu or the SA:MP UI (Resume / Esc / Enter / a click: a recent user gesture, which the
      // browser needs for the pointer lock): capture the pointer again, so the game has it at once
      if (wasMenu && !inMenu && m.state === 9 && document.pointerLockElement !== canvas && document.hasFocus()) {
        canvas.requestPointerLock?.()?.catch?.(() => {});
      }
      if ((m.uiCursor || m.menuActive) && document.pointerLockElement === canvas) { selfRelease = true; document.exitPointerLock?.(); }
      canvas.classList.toggle('menu', inMenu && document.pointerLockElement !== canvas);
      $('blocked').textContent = m.blocked ? `blocked iterations: ${m.blocked}, last: ${m.lastBlocked} (not ported yet)` : '';
    }
  };
  worker.onerror = (e) => log(`worker error: ${e.message}`, 'error');
  const env = {};
  env.SA_GAME_SCRIPT_SKIP = '1';
  const stub = params.get('stub');
  if (stub !== 'none') env.SA_GAME_STUB = stub ?? DEFAULT_STUBS;
  for (const [k, v] of params) if (k.startsWith('SA_')) env[k] = v;
  if (params.get('auto') === '1') env.SA_WEB_AUTO_INPUT = '1';
  // ?mods=a,b: the WebAssembly mods mods/a/, mods/b/ of the server (tools/web/serve.sh --mods DIR; build with
  // FEATURES=mods; docs/mods/getting-started.md)
  if (params.get('mods')) env.SA_MODS = params.get('mods');
  // the UDP proxy the mods' sockets go through (?proxy=ws://..., sa-udp-proxy; default ws://127.0.0.1:7781)
  if (params.get('mods') && params.get('proxy')) env.SA_MODS_PROXY = params.get('proxy');
  const audioOut = await initAudio();
  const off = canvas.transferControlToOffscreen();
  const transfer = loaderPort ? [off, loaderPort] : [off];
  worker.postMessage({ type: 'start', canvas: off, files, loaderPort, ioSab, ioStacks: params.get('io_stacks') === '1', cacheMb: Number(params.get('cache_mb') || 0), env, audio: audioOut, audioTap: params.get('audiotap') === '1', startInWorld: $('inworld').checked, backend: params.get('backend') ?? '', display: displaySize() }, transfer);
  canvas.focus();
}

// the game's files: the engine carries the exe's data itself, so gta_sa.exe is neither read nor copied
function gameFiles(list) {
  return list.filter((f) => f.path.toLowerCase() !== 'gta_sa.exe');
}

// A folder picked as a fallback. Selecting it prepares the session; Run Game starts it.
$('pick').addEventListener('change', (e) => {
  const list = gameFiles([...e.target.files].map((f) => ({
    path: f.webkitRelativePath.split('/').slice(1).join('/'),
    size: f.size,
    file: f,
  })));
  if (!list.some((f) => f.path.toLowerCase() === 'models/gta3.img')) {
    log('that folder has no models/gta3.img (choose the GTA San Andreas folder itself)', 'error');
    $('local-status').textContent = 'That folder does not contain models/gta3.img.';
    return;
  }
  selectedGameFiles = list;
  $('local-status').textContent = `Selected folder · ${list.length} files`;
  statusEl.className = 'ready';
  statusEl.textContent = `Local game folder ready · ${list.length} files`;
  $('run-game').disabled = false;
  $('run-game').textContent = 'Run Game';
});

// Resolve the bundled manifest against this script, not the current document URL. This works when
// the page is served from the repository root and when web/ is opened directly.
function bundledFiles(index, gameRoot) {
  const fileUrl = (path) => new URL(path.split('/').map(encodeURIComponent).join('/'), gameRoot).href;
  return gameFiles(index.map((f) => ({
    path: f.path, size: f.size, mtime: f.mtime, revision: f.sha256 ?? '',
    url: fileUrl(f.path),
    ...(Array.isArray(f.parts) ? { parts: f.parts.map((p) => ({ ...p, url: fileUrl(p.path) })) } : {}),
  })));
}
async function loadBundledGame() {
  const scriptDir = new URL('.', import.meta.url);
  const cloudflareCdn = new URL('https://cdn.humming6ird-9.workers.dev/');
  const candidates = [
    { manifest: new URL('game/game-index.json', scriptDir), root: new URL('game/', scriptDir) },
    { manifest: new URL('../game/game-index.json', scriptDir), root: new URL('../game/', scriptDir) },
    { manifest: new URL('/game/game-index.json', scriptDir), root: new URL('/game/', scriptDir) },
    // GitHub Pages' Jekyll build excludes game/. The Cloudflare CDN worker has a
    // /GTA-San-Andreas/* route that proxies these files from this repository's main branch.
    {
      source: 'Cloudflare CDN',
      manifest: new URL('GTA-San-Andreas/game/game-index.json', cloudflareCdn),
      root: new URL('GTA-San-Andreas/game/', cloudflareCdn),
    },
  ];
  const seen = new Set();
  const failures = [];
  for (const candidate of candidates) {
    const manifestUrl = candidate.manifest.href;
    if (seen.has(manifestUrl)) continue;
    seen.add(manifestUrl);
    let response;
    try {
      response = await fetch(candidate.manifest, { cache: 'no-store', headers: { Accept: 'application/json' } });
    } catch (error) {
      failures.push(`${manifestUrl}: ${error.message ?? error}`);
      continue;
    }
    if (!response.ok) {
      failures.push(`${manifestUrl}: HTTP ${response.status}`);
      continue;
    }
    let index;
    try {
      index = await response.json();
    } catch (error) {
      failures.push(`${manifestUrl}: invalid JSON (${error.message ?? error})`);
      continue;
    }
    if (!Array.isArray(index) || !index.length) {
      failures.push(`${manifestUrl}: expected a non-empty JSON array`);
      continue;
    }
    const hasMainArchive = index.some((f) =>
      typeof f.path === 'string' && f.path.toLowerCase() === 'models/gta3.img');
    if (!hasMainArchive) {
      failures.push(`${manifestUrl}: models/gta3.img is missing from the manifest`);
      continue;
    }
    const list = bundledFiles(index, candidate.root);
    if (!list.length) {
      failures.push(`${manifestUrl}: no usable game files after filtering`);
      continue;
    }
    bundledGameFiles = list;
    statusEl.className = 'ready';
    statusEl.textContent = 'Ready';
    $('run-game').disabled = false;
    $('run-game').textContent = 'Run Game';
    $('local-status').textContent = candidate.source
      ? 'Bundled game data found via the Cloudflare CDN.'
      : 'Bundled game data found in this repository.';
    log(`bundled game manifest: ${manifestUrl} (${list.length} logical files)`);
    return true;
  }
  const detail = failures.join(' · ') || 'no manifest candidates were available';
  log(`bundled game lookup failed: ${detail}`, 'error');
  statusEl.className = 'err';
  const hostOmittedGameData = failures.some((failure) => /HTTP 404/.test(failure));
  statusEl.textContent = hostOmittedGameData ? 'Game data not included' : 'Bundled game data not found';
  $('local-status').textContent = hostOmittedGameData
    ? 'The repository contains game/, but GitHub Pages omits it from the Jekyll output. The launcher also tried the Cloudflare CDN fallback; check the network log if that request failed.'
    : detail;
  return false;
}

async function launchGame() {
  const files = selectedGameFiles ?? bundledGameFiles;
  if (!files?.length || worker) return;
  $('run-game').disabled = true;
  $('run-game').textContent = 'Starting…';
  $('ministatus').textContent = 'Starting game…';
  bootFinished = false;
  $('boot-overlay').hidden = false;
  $('boot-overlay').classList.remove('splash');
  $('boot-progress').hidden = false;
  $('nvidia-splash').hidden = true;
  document.body.classList.remove('boot-splash');
  document.body.classList.add('boot-loading');
  updateBootProgress({ mib: 0 });

  // Reveal the stage first, then request real browser fullscreen directly from this button gesture.
  document.body.classList.add('game-active');
  const stage = $('stage');
  stage.getBoundingClientRect();
  let fullscreenRequest = null;
  try {
    fullscreenRequest = stage.requestFullscreen?.();
  } catch (e) {
    log(`fullscreen unavailable: ${e}`);
  }
  fullscreenRequest?.catch?.((e) => log(`fullscreen unavailable: ${e}`));
  displayChanged();

  try {
    await start(files);
  } catch (e) {
    log(`could not start the game: ${e}`, 'error');
    statusEl.className = 'err';
    statusEl.textContent = `Could not start the game: ${e.message ?? e}`;
    $('boot-overlay').hidden = true;
    document.body.classList.remove('boot-loading');
    document.body.classList.remove('boot-splash');
    document.body.classList.remove('game-active');
    $('run-game').disabled = false;
    $('run-game').textContent = 'Try Again';
  }
}
$('run-game').addEventListener('click', launchGame);

loadBundledGame().then((found) => {
  if (!found) {
    statusEl.className = 'err';
    statusEl.textContent = 'Bundled files unavailable · check details';
    $('alternate-source').open = true;
  }
}).catch((e) => {
  log(`bundled game could not be loaded: ${e}`, 'error');
  statusEl.className = 'err';
  statusEl.textContent = `Bundled game check failed · ${e.message ?? e}`;
  $('local-status').textContent = `Manifest check error: ${e.message ?? e}`;
  $('alternate-source').open = true;
});

// ---------------------------------------------------------------- input ---
// Physical DOM scan codes are passed through unchanged. The preferred keyboard bindings (Shift = sprint,
// Space = jump) are set by CControllerConfigManager::InitDefaultControlConfiguration in sa-input.
const PASS = new Set(['F5', 'F11', 'F12']);
function onKey(down) {
  return (e) => {
    if (e.code === 'Digit0') {
      e.preventDefault();
      if (down && !e.repeat) toggleLogs();
      return;
    }
    if (!worker || PASS.has(e.code)) return;
    e.preventDefault();
    worker.postMessage({ type: 'key', code: e.code, down, repeat: e.repeat, text: down && e.key.length === 1 ? e.key : '' });
  };
}
window.addEventListener('keydown', onKey(true));
window.addEventListener('keyup', onKey(false));
window.addEventListener('blur', () => worker?.postMessage({ type: 'blur' }));

// the game's client size (its video mode; the worker's status reports it): the canvas keeps its aspect
let client = [800, 600];
// the display the game's mods see (e.g. the resolution mod): the space the canvas can take on the page in device
// pixels: the viewport in full window / fullscreen, else the canvas's 800 x 600 CSS box
function displaySize() {
  const full = document.body.classList.contains('game-active') || !!document.fullscreenElement;
  const [w, h] = full ? [window.innerWidth, window.innerHeight] : [800, 600];
  const dpr = window.devicePixelRatio || 1;
  return [Math.round(w * dpr), Math.round(h * dpr)];
}
let displayTimer = null;
function displayChanged() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    const [w, h] = displaySize();
    worker?.postMessage({ type: 'display', w, h });
  }, 250);
}
window.addEventListener('resize', displayChanged);

// Browser fullscreen is requested by Run Game. The game remains viewport-sized if the user exits browser fullscreen.
let inMenu = true;
// the page released the pointer lock itself (the SA:MP UI shows its cursor), not the user's Esc
let selfRelease = false;
$('fullwin').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen?.().catch?.((e) => log(`could not leave fullscreen: ${e}`, 'error'));
};
$('fullscreen').onclick = () => {
  if (!document.fullscreenElement) $('stage').requestFullscreen?.().catch?.((e) => log(`fullscreen unavailable: ${e}`, 'error'));
};
$('unfull').onclick = () => {
  const leave = document.fullscreenElement ? document.exitFullscreen?.() : null;
  Promise.resolve(leave).catch(() => {}).finally(() => location.reload());
};
function toggleLogs(force) {
  const show = typeof force === 'boolean' ? force : !document.body.classList.contains('show-logs');
  document.body.classList.toggle('show-logs', show);
  $('logs-toggle').setAttribute('aria-pressed', String(show));
  $('logs-toggle').textContent = show ? 'Hide logs · 0' : 'Logs · 0';
}
$('logs-toggle').onclick = () => toggleLogs();
document.addEventListener('fullscreenchange', () => {
  // in fullscreen Chromium lets the page keep Esc (Keyboard Lock API): it then reaches the game like any key
  if (document.fullscreenElement) navigator.keyboard?.lock?.(['Escape']).catch(() => {});
  else navigator.keyboard?.unlock?.();
  displayChanged();
  canvas.focus();
});

// the pointer position in the game's client pixels (the canvas is scaled by CSS)
function gamePos(e) {
  const r = canvas.getBoundingClientRect();
  return [Math.round((e.clientX - r.left) * client[0] / r.width), Math.round((e.clientY - r.top) * client[1] / r.height)];
}

// menus (gGameState other than IDLE): no pointer lock; the absolute position goes to the game as WM_MOUSEMOVE (the
// menu draws its own cursor there, the OS cursor is hidden over the picture) and clicks are menu clicks.
canvas.addEventListener('mousemove', (e) => {
  if (worker && inMenu && document.pointerLockElement !== canvas) {
    const [x, y] = gamePos(e);
    worker.postMessage({ type: 'mousepos', x, y });
  }
});

// mouse: in the world a click locks the pointer (DirectInput exclusive mode: relative motion). That click is not a game button
// press (natively sa-game captures the pointer itself, no click reaches the game for it): otherwise capturing the mouse
// in the world would also punch. Buttons reach the game only while the pointer is locked.
canvas.addEventListener('mousedown', (e) => {
  if (!worker) return;
  if (document.pointerLockElement !== canvas) {
    if (inMenu) {
      const [x, y] = gamePos(e);
      worker.postMessage({ type: 'mousepos', x, y });
      worker.postMessage({ type: 'button', button: e.button, down: true });
      return;
    }
    canvas.requestPointerLock?.();
    return;
  }
  worker.postMessage({ type: 'button', button: e.button, down: true });
});
// the capture indicator (pointer lock comes and goes with clicks, Esc and focus changes)
// Esc while the pointer is locked never reaches the page: the browser uses it to release the lock. When the lock goes
// away in game (not released by the page, the page still focused), that was the user's Esc: pass it to the game, which
// opens the pause menu as the original does on Esc.
let lockWasOn = false;
document.addEventListener('pointerlockchange', () => {
  const on = document.pointerLockElement === canvas;
  if (lockWasOn && !on && !selfRelease && !inMenu && worker && document.hasFocus()) {
    worker.postMessage({ type: 'key', code: 'Escape', down: true, repeat: false, text: '' });
    setTimeout(() => worker?.postMessage({ type: 'key', code: 'Escape', down: false, repeat: false, text: '' }), 80);
  }
  lockWasOn = on;
  selfRelease = false;
  $('mouse').textContent = `mouse captured: ${on ? 'yes' : 'no'}`;
  $('mouse').className = on ? 'on' : 'off';
  window.saGame.mouseCaptured = on;
});
document.addEventListener('pointerlockerror', () => {
  $('mouse').textContent = 'mouse captured: no (the browser refused the pointer lock; click the picture again)';
});
document.addEventListener('mousemove', (e) => {
  if (worker && document.pointerLockElement === canvas) {
    worker.postMessage({ type: 'mouse', dx: e.movementX, dy: -e.movementY });
    window.saGame.mouseX = (window.saGame.mouseX ?? 0) + e.movementX;
  }
});
window.addEventListener('mouseup', (e) => worker?.postMessage({ type: 'button', button: e.button, down: false }));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  worker?.postMessage({ type: 'wheel', lines: -Math.sign(e.deltaY) });
}, { passive: false });
