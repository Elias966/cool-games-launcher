# Testing

How the launcher is checked. Use isolated profiles for anything that runs the
app: never point a test at `~/.local/share/cool-games-launcher` (the user's
real database, Firefox profile, models and library).

## Every change

```bash
npm run typecheck
npm test          # Vitest: ~277 tests, ~15 s
npm run build
```

`npm run dist` repeats all three, then builds the AppImage (static runtime
repack, checksums in `release/SHA256SUMS`).

The unit suites cover: page extraction and site recipes (`site-recipe`,
`page-extract`), indexing durability and recovery (`store-persistence`,
`store-recovery`, `store-exit`), foreground priority and AI search
(`foreground-search`), the Fara agent loop against Microsoft's harness format
(`agent-team`, `game-agent`), downloads (`transfer`, `parallel-transfer`),
extraction (`extract`, `prepare-game`, `exec-scan`), models, Proton and policy.
Model decisions in these suites come from deterministic stubs
(`tests/helpers/fixture-agent.ts`); they test plumbing, not model quality.

## Running the real app in isolation

Run the unpackaged build under Xvfb with its own XDG directories, sharing only
the downloaded models (read-only) and the NVIDIA shader cache:

```bash
R=/tmp/cgl-run; mkdir -p $R/data/cool-games-launcher $R/config $R/cache $R/cap
ln -s ~/.local/share/cool-games-launcher/models $R/data/cool-games-launcher/models
ln -s ~/.cache/nvidia $R/cache/nvidia   # otherwise the first AI call recompiles GPU shaders (~80 s)
XDG_DATA_HOME=$R/data XDG_CONFIG_HOME=$R/config XDG_CACHE_HOME=$R/cache \
CGL_DEBUG=1 CGL_DEV_CAPTURE=$R/cap \
  xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/.bin/electron . --ignore-gpu-blocklist
```

- `CGL_DEBUG=1` logs page reads (`[index] http …`), Fara's reasoning and click
  targets, and classifier timings.
- `CGL_DEV_CAPTURE=<dir>` (unpackaged only): `kill -USR2 <main pid>` saves a
  window screenshot there; `kill -USR1` runs `<dir>/eval.js` in the renderer and
  writes the result to `eval.out` (use it to click tabs or call `window.cgl.invoke`).
- Every run also writes `<data>/logs/launcher.log`.

Pitfalls:

- Stop the app with SIGTERM to the **main** process only. Killing Chromium's
  helper processes makes Electron abort mid-shutdown.
- Make sure no older test instance is still running: it holds the GPU and the
  next model silently loads mostly on the CPU.
- Never type `pgrep -f`/`pkill -f` patterns inline in a shell an agent runs;
  the pattern matches that shell itself. Put them in a script file.

## Real-site checks (manual, legitimate sources only)

Use free, legitimately distributed games (itch.io, Game Jolt) and a local test
site for edge cases. Checks performed for 0.2.x:

| Scenario | Result |
|---|---|
| Index itch.io free Linux games from a fresh profile | first 10 visible ≈ 10 s, 100 ≈ 90 s (itch.io rate-limits) |
| Game Jolt (JavaScript-only site) | layout learned via Firefox fallback; downloads verified |
| IndieDB (Cloudflare) | handed to the user, other sources continue |
| Download a Linux game → Library | 28 s, correct executable |
| Windows-only game → GE-Proton auto-install → umu launch | fullscreen, renders |
| Site whose catalog links sit in a collapsed (hidden) menu | AI learned `/games-list/` + genre routes from the hidden menu, all 24 games |
| Site reachable only through robots.txt → sitemap index | all 24 games found and titled; an existing source with an old recipe re-read its site map automatically after restart |
| Installed game, site publishes v1.1 on the same page | detected from the Library with the Store closed; update downloaded via the AI, executable matched without the AI, 3 player files (saves, settings) carried into the renamed `Orbit Run v1.1/` folder |
| Roll back | back on v1.0 with a save made in v1.1; v1.1 folder removed and not offered again |
| v1.2 posted as a new page, automatic updates on | catalog entry followed the new post; update installed by itself with 4 player files; old version deleted after a 62 s play session |
| Press Download, switch to the Library at once | Library showed "Finding the download → Downloading → Preparing", then unlocked the game; AI chose the executable without the Store open |
| Site with a "Popular" menu page and a "Trending now" front-page block | Popular / Trending sorts followed the site's order (#1–#3) |
| Copy of a 4,922-game catalog: descriptions | opened games whose page had only an SEO line got their Steam short description |
| Same catalog, Store frame rate (virtual display, RTX 3070 via Vulkan) | 960 cards scrolling: 35 fps / 9 slow frames vs 26 fps / 41 slow frames for 0.2.4 at 480 cards; card hover 31 vs 12 fps; Store without the 3D scene idles at 60 fps. The virtual display copies every WebGL frame back to the CPU, so the 3D scene costs far more there than on a real screen |
| Split game, 3 × `.7z.001` direct links (local site, real AI) | parts 2–3 queued from the direct links, one combined Library entry, unpacked once from the first volume |
| Split game, 2 × `-PartN.zip` behind file-host pages | AI fetched part 2 on its own ("ONLY PART 2"), parts unpacked into one folder |
| Unpack step answered with a browser action | asked again automatically; game installed |
| Steam store data on a 4,900-game catalog copy | banner, logo, capsules, review score, release date, description, 6 screenshots, 4 trailers (preview plays 30 fps) for an opened game |
| Couch mode with keyboard | rows Continue playing / Trending / Popular; focus moves; hero shows logo, reviews, description |
| Pre-installed nested 7z/zip with larger decoy exes | AI picked `Game/CARL.exe` both times |
| Launch / close / relaunch packaged AppImage ×3 | model loads on GPU each time, nothing left running |
| Crash (SIGKILL main) then restart | leftovers reaped, model back on GPU |

A minimal local test site is a folder of static HTML served with
`python3 -m http.server 8765 --bind 127.0.0.1` and added as a source
(`http://127.0.0.1:8765/`).

## Browser regression harness

`xvfb-run -a node scripts/live-browser-test.mjs /tmp/cgl-browser-test` drives the
bundled Firefox and the downloads worker against local fixtures: clicks, typing,
popups, POST-only and cross-host downloads, parallel ranges with
pause/resume/crash recovery, and ZIP/RAR preparation. AI choices are stubbed.

## Packaged builds on other distributions

`scripts/distro-smoke.sh <AppImage> <scratch> [ubuntu22 ubuntu24 debian12 fedora42]`
runs the AppImage inside rootless bwrap root filesystems on Xvfb (startup,
model/projector health, Firefox, classifier, clean shutdown). It shares the host
kernel; it does not certify every GPU driver or desktop. See BUILDING.md.

## Classifier accuracy

`npm run eval:classifier` measures the content classifier; see CLASSIFIER.md.
The fp16 model used since 0.2.0 matches the fp32 reference (max score
difference 0.002 on 40 real covers).
