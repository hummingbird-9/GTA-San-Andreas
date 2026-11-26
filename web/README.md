# sa-engine in the browser (WEB-1)

The phase B game (`crates/sa-game`) built for `wasm32-unknown-unknown` and run in a Web Worker: the same boot,
main loop and ports as the native `sa-game --window`, drawing through wgpu (WebGPU, else WebGL2) into an
`OffscreenCanvas`. No game asset is shipped: it reads **your own** GTA San Andreas 1.0 US folder. The exe's
initial data is built into the module (`crates/sa-image`), so the page neither needs nor copies `gta_sa.exe`.

## Build and run it

For a complete static-site bundle (the same files you can upload to a static host):

```sh
tools/web/package.sh                 # release WASM build + complete site in dist/
tools/web/serve.sh --web dist        # http://localhost:8642/
```

Open <http://localhost:8642/> and choose a folder containing `models/gta3.img` under "Use a different GTA San
Andreas folder". Then press **Run Game**. The browser reads the files locally (they are never uploaded). The
**Skip intro mission** option is off by default; enable it to start directly in the world. Run Game opens the
canvas in browser fullscreen. This browser profile uses **Shift to sprint** and **Space to jump**; in-game vertical mouse movement is inverted. Press **0** to show or hide the engine log. The HUD retains mute, volume, cache download, Full window, Fullscreen, and Exit game controls. Click the picture to capture the mouse; W A S D walk.

For development without copying the site into `dist/`, the shorter workflow remains available:

```sh
tools/web/build.sh
tools/web/serve.sh
```

The standalone package is generated, not committed. `dist/` contains the browser page, worker files, audio worklet,
and generated `pkg/sa_game.js` + `pkg/sa_game_bg.wasm`. It does not contain a GTA install; each player selects
their own game folder in the browser. See [`docs/WEB-DEPLOYMENT.md`](../docs/WEB-DEPLOYMENT.md) for downloads,
static hosting, and the private-data restriction on public Pages.

Development shortcut: `tools/web/serve.sh --game ~/sa-engine/wine/gta-sa` also serves that folder to this machine
only (ranged reads), and <http://localhost:8642/?autostart=1> starts with it without the picker.

URL options: `?inworld=0` plays the intro mission; `?auto=1` adds the native offscreen mode's synthetic input
(Enter through the menus, `SA_GAME_WALK`); any `SA_*` development variable (`SA_GAME_STUB=...`,
`SA_GAME_WALK=40:200`, `SA_GAME_SCRIPT_SKIP=1`, ...) is passed to the game as natively.

Status (2026-11-12, WEB-2): headless Chromium on WebGL2 boots to the world and CJ walks and looks around with real
keys and mouse, on WebGL2 and on WebGPU (an AMD GPU). An unported callee ends only its main-loop iteration (a
"blocked" step, as natively; the page shows the count and the last blocked function); unlike natively, repeated
blocks do not stop the loop. Click the picture to capture the mouse, Esc releases it. The page applies the play
package's exploration stubs by default: `&stub=ADDR=RET/N,...` replaces them, `&stub=none` drops them. `?backend=gl` forces WebGL2, the path
verified headless. Details: `docs/arch/platform.md` section 22.

`Run Game` opens the session in browser fullscreen; if the browser exits fullscreen, the canvas continues filling
the browser viewport. The game keeps its video mode and the canvas is scaled, letterboxed at 4:3. In the menus (gGameState
other than IDLE) the pointer is not captured: its position reaches the game as `WM_MOUSEMOVE` (the menu draws its own
cursor and highlights the item under it) and clicks are menu clicks; in the world a click captures the mouse.

Needs a browser with WebGPU (Chromium 113+, Firefox 141+ on supported systems) or WebGL2 and module workers.

## How it maps the native build

| native (i686 Linux) | web (wasm32) |
|---|---|
| legacy arena mapped with `mmap(MAP_FIXED)` at 0x401000..0xCB1000, `.HOODLUM`, COM pages at 0x30000 | the same addresses in linear memory: the module is linked with `--global-base=0x1600000 --no-stack-first`, so everything below 0x1600000 is free for the arena (`tools/web/check_layout.mjs` checks it) |
| registry entries with the original calling convention | type-erased entries (`sa_core::wabi`): arguments as the original's stack words, results as EAX:EDX or ST0 |
| game folder through `std::fs` | `webfs.rs`: the page's `File`s (`FileReaderSync`) or the localhost server (ranged synchronous requests), 256 KiB block cache |
| `CdStream` streaming thread, audio threads | no threads: the streaming thread's loop body runs at each release of its semaphore; the audio threads (smooth fades, stream decoder) run one pass after each main-loop iteration (the stream thread every 100 ms) |
| frame limiter `sleep`, `Sleep()` | no sleeping; the worker runs main-loop iterations for up to 12 ms per task and yields after a `Present` |
| winit keyboard / mouse | DOM `KeyboardEvent.code` / pointer-lock motion, posted to the worker, the same `InputState` (window messages + DirectInput state) |
| CPUID | a fixed virtual SSE2 CPU (the paths of the native runs) |
| audio (DirectSound mixer thread → cpal) | the same mixer, once per main-loop iteration, into an AudioWorklet (shared ring buffer; the play cursors follow the AudioContext) |

## Audio (WEB-AUDIO)

The game's own audio code (`CAudioEngine`, `CAESoundManager`, `CAEAudioHardware`) plays through sa-game's emulated
DirectSound (`crates/sa-game/src/dsound.rs`), whose software mixer (volume, pan, frequency, looping; 44.1 kHz stereo
16-bit, the primary format the game sets) feeds an AudioWorklet (`audio-worklet.js`). The dev server sends
`Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp`, so the page is cross-origin
isolated and the worker writes a SharedArrayBuffer ring the worklet reads; each main-loop iteration tops it up to
~93 ms, so the DirectSound play cursors advance by what the AudioContext actually played. Without isolation (another
server) the worker posts chunks through the page and the cursors follow real time.

Browsers start sound only after a gesture: **click the picture** (the same click captures the mouse) or press a key.
The bar shows `audio: running` / `suspended`, with **mute** and a **volume** slider (remembered per browser).

Plays today: the game's static channels (front-end sounds, footsteps and the other sound-bank effects in the world;
about 1,600 `Play` calls in two minutes of walking). Streamed audio (radio, the loading tune, mission audio): the
stream path is ported and `vorbisfile.dll` is replaced (lewton, docs/arch/platform.md 22.9), but on wasm32 the page
hangs once streams decode, so streams stay off in the browser unless `SA_GAME_WEB_STREAMS` is set (debugging only).
The mixer resamples with a 16-tap windowed sinc and mixes in f32. 3D positioning is not rendered (2D mix).

Evidence runs: `?audiotap=1` and `node tools/web/headless.mjs --audio ...` write `OUT/audio.wav` and
`OUT/audio-rms.tsv` (derived from your game files: never commit them). `SA_GAME_DSOUND_TRACE=1` logs `Play` and
`SetFrequency` calls and the playing buffers every 3 s.

## SA:MP

SA:MP runs as the samp mod (docs/samp/README.md, "Running SA:MP"): the build with mods (`FEATURES=mods
tools/web/build.sh`), the mod folders served with `serve.sh --mods target/mods`, the page opened with
`?mods=samp&proxy=ws://127.0.0.1:7781`. A page cannot open UDP, so the mod's sockets are WebSockets to `sa-udp-proxy`
(`crates/sa-udp-proxy`, docs/samp/web-proxy.md), which relays the datagrams unchanged to the server
(`sa-udp-proxy HOST:PORT --bind 127.0.0.1:7781`). The page's storage starts empty: the mod reads its settings and the
auth table (third-party data, never committed) from files of the same name in its served folder, and the game asks
before the mod reaches a server. The headless join test: `WEB=1 tools/e2e/samp/mod-join.sh`.

## Files

* `index.html`, `main.js`: the launch screen, optional folder picker, input forwarding, status line, log panel
* `worker.js`: the worker (module loader, synchronous file reads, main loop scheduling, the audio ring's writer)
* `audio-worklet.js`: the AudioWorklet processor that plays the game's mix
* `pkg/`: build output of `tools/web/build.sh` (not committed)
* `../tools/web/headless.mjs`: unattended evidence runs in headless Chromium over the DevTools protocol
