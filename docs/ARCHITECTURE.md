# Architecture

## Processes

```
┌──────────────────────── Electron main (src/main) ────────────────────────┐
│ composition root · SQLite (node:sqlite) · validated IPC · cgl-media://   │
│ StoreSession · PolicyService · Discovery · PageFetcher · Resolver        │
│ DownloadManager · BrowserView (drawer) · Library · CompatManager         │
└──┬────────────┬────────────────┬───────────────┬──────────────┬──────────┘
   │ utilityProcess (MessagePort RPC, cancellable requests)                 
   ▼            ▼                ▼               ▼              ▼
 inference    browser          fetcher ×3      downloads      install
 llama-server geckodriver +    HTTP page reads resumable      safe extraction,
 (UNIX socket) bundled Firefox + jsdom extract  HTTP(S)       exec scan, launch
 fp16 classifier (profile,      (no rendering)  transfers     (native/Wine/umu)
 (WebGPU/CPU)  uBlock)
```

The renderer (`src/renderer`) is a sandboxed, context-isolated React app with no
Node.js access. It talks to main only through `window.cgl` (`src/preload`),
whose every request is validated against zod schemas in `src/shared/ipc.ts`,
and only from the app's own page (`file://…/out/renderer/index.html`).

Website content **never** loads in Electron. The Store browser drawer shows
PNG snapshots of the bundled Firefox and forwards clicks, scrolling and typing
through WebDriver. Artwork and snapshots reach the renderer only through the
`cgl-media://` protocol, which checks the current visibility policy for every
request. The renderer's CSP allows no remote origins.

## Store session and cancellation

`StoreSession` (`src/main/store-session.ts`) is active only while the Store tab
is shown. Each session has an epoch and an `AbortSignal`. Every AI request,
browser action for discovery/resolution and AI-derived write calls
`assertLive(token)` before and after awaiting. Leaving the Store:

- aborts the signal → the inference worker disconnects from llama-server,
  which cancels the generation slot within ~0.5 s;
- advances the epoch → any answer that still arrives is discarded
  (`StaleResultError`) before it can touch the catalog;
- stops page loads in the discovery window;
- leaves transfers already handed to the downloads worker untouched.

Discovery checkpoints its crawl cursor before each page, and resolution saves
its page and step history, so both resume on the next Store visit.
`tests/store-exit.test.ts` covers this with a worker whose answers arrive late.

## Visibility policy

`PolicyService` keeps the NSFW preference, the consent record and a **policy
revision** that increments on every change. Catalog queries filter by rating in
SQL alongside `download_status = available`; responses carry the revision they were produced under, and the renderer
drops anything older. On disable, main also sends the ids that must disappear,
the renderer removes them and closes an open adult detail immediately, the
media protocol starts refusing their artwork (HTTP 403), and the browser drawer
withholds frames until one approved under the new revision arrives.

Ratings are `safe`, `adult` or `unknown`. `unknown` (pending or failed) is never
visible. See `src/shared/policy.ts` and [CLASSIFIER.md](CLASSIFIER.md).

## Download resolution

`Resolver` drives the drawer's Firefox window:

1. `LocalGameAgent` receives a fresh screenshot, extracted visible data and action
   history on every turn. It chooses an observed control/file or a browser action.
   Schema-constrained decisions are validated against current observations; model
   failures are surfaced without a scripted route fallback.
2. Login, required payment and age gates pause for the user. The agent never
   interacts with CAPTCHAs or other human checks: it waits briefly for checks that
   clear on their own, returns to the game page and tries another mirror (up to
   three gated hosts), and only then asks the user; a watcher resumes the download
   as soon as the check is gone. A failed route search retries once with a fresh
   agent conversation. "Name your own price" pages take their free path.
3. External landing pages, mirrors and HTML interstitials remain in Firefox,
   including delayed redirected download popups. Direct file URLs are probed before
   HTTP handoff. Firefox-created transfers preserve POST bodies, signed URLs,
   cookies and blobs. Cookie lookup filters by the actual target domain/path/expiry.
4. Download/extract/library are distinct trusted tools. The model approves the
   package and selects the playable executable; it never receives a shell or
   unrestricted filesystem writes. Unrelated recommendations and account/purchase
   controls are excluded from eligible actions.

## Downloads

`DownloadManager` persists every record. Display progress is persisted in SQLite every 2 s. Transfers use 8 connections by default (configurable 1–16 independently from queue concurrency). A `bytes=0-0` GET proves bounded-range support and discovers a stable validator. Files of at least 2 MiB split into ranges of at least 1 MiB, with strict Content-Range, validator, encoding and byte-count checks. Each connection writes to its range in a shared sparse `.part` file; an atomic `.segments.json` sidecar records only completed writes every 250 ms and on stop. Recovery counts checkpointed bytes rather than sparse file size. A contiguous legacy prefix migrates only with matching validators and size. Changed versions or unsupported ranges discard sparse data and safely restart one stream. Full probe responses are consumed directly when Range is ignored, avoiding a second GET. Firefox-created/POST/one-use transfers stay in Firefox. Cancellation removes the partial file and sidecars. Errors map to states:
network (retry with exponential backoff, up to 5 times), expired link
(401/403/404/410 or an HTML page → *needs resolution*, re-resolved in the Store,
continuing the same `.part` with `If-Range`), disk full (paused), others failed.
After a restart, active transfers are queued again; interrupted resolutions
continue when the Store opens.

## Installation and launching

A catalog download authorizes preparation: Library queues extraction automatically on completion, including Firefox transfers. Preparation runs one game at a time while Store is active and resumes completed/interrupted records on the next Store visit. Model approval precedes extraction; the extracted file list is persisted before executable selection so cancellation/restart does not require re-extraction. Existing game records repair missing download registration rather than duplicating games. A private staging folder is atomically moved into the library after successful extraction; failures remove staging and retain the archive.

The install worker starts no executable during preparation. ZIP, RAR, 7z and tar (gz/xz/bz2/zst) archives are extracted with path, link, device-file and zip-bomb
checks (`src/workers/extract.ts`), or copies single binaries/AppImages/Windows
executables. In agent-managed preparation it inventories executables (ELF, AppImages, shebang scripts, PE), but leaves selection to the model. Installers are ineligible; invalid or absent model choices stop preparation instead of falling back to ranking. Windows installers are only run when you
press *Run installer*, inside that game's own prefix. Launching uses the game
folder as working directory, a clean environment (AppImage variables removed)
and per-game logs. Uninstall deletes only folders inside the launcher's games
or prefixes directories.

## Game updates

`src/shared/game-version.ts` fingerprints the build a game page offers
(version/build number from titles, file names or a labelled line; download file
names and sizes; `article:modified_time`). Discovery stores it on each verified
catalog entry (`version_json`); a listing that announces a newer version under
the same title key re-queues the entry (moving it to the new page when the new
build is a separate post), and sitemap `<lastmod>` newer than the last check
re-queues it too. `UpdateService` (`src/main/updates.ts`) re-reads installed
games' pages over HTTP on the indexing interval, independent of the Store
session and without the AI, and HEADs the original download for changed
validators. Verdicts live in `games.update_json`; skipped and rolled-back builds
are remembered by fingerprint key.

Updating downloads through the normal resolver with `downloads.update_game_id`
set. `Library.prepareUpdate` extracts into a new folder, records the pristine
file list (`<data>/manifests`), matches the executable by name (the AI decides
only when that is ambiguous), and `applyUpdate` copies files the player created
or changed (`workers/carry-over.ts`, rebased across renamed top folders, never
overwriting programs) before switching the game record. The replaced build is
`games.previous_json` until a play session of at least 60 s; rollback carries
newer saves back and removes the newer build.

## Data

`~/.local/share/cool-games-launcher/launcher.db` (SQLite, WAL) holds settings,
consent, sources (with crawl cursors), catalog entries and ratings, downloads
(with resolution and extraction checkpoints), games, an AI-answer cache, per-image
classification results keyed by classifier version, and each source's AI-learned
site recipe (`sources.recipe_json`). `<data>/logs/launcher.log` records main and
worker output (rotated at 4 MB).

## Shutdown

Main stops AI and browser, stops workers (each kills its own children:
llama-server, geckodriver, Firefox), closes the database, and then ends the
process. Chromium's own exit path intermittently stalled after the utility
processes stopped (always after SIGTERM), so the process ends itself once state
is flushed; its Chromium children exit with it. Workers handle SIGTERM to stop
their own children (geckodriver survives Selenium's `quit()` otherwise). If the
launcher dies abruptly anyway, the next start reaps leftover llama-server,
geckodriver and Firefox processes (`src/main/orphans.ts`), which would otherwise
hold the GPU memory and the browser profile.

## Downloadable catalog and filters

Listings begin as `pending`. Cards the AI confirmed as games become `listed` once their cover passes the content check, and show in the Store marked "Verifying"; a detail visit then sets `available` (an observed file, upload, host landing link or download control) or `unavailable` (hidden). AI prose cannot create download evidence. Detail failures retry at most three times; source refresh resets attempts. New detail metadata invalidates its prior content rating before reclassification, so concurrent Store requests cannot expose unchecked descriptions, taxonomy or images.

Categories and tags are extracted from site taxonomy, JSON-LD and page metadata, normalized and merged. SQL applies category/tag/source/platform/search filters before pagination. Facets include only currently visible, verified downloadable entries.

## Proton releases and provisioning

`ProtonReleases` reads fixed official GitHub repositories (Valve, GE and CachyOS), caches raw responses and ETags, and refreshes at startup/every 15 minutes. Offline or rate-limited refresh keeps the prior cache. Only baseline x86_64 assets from the corresponding release repository with published SHA-256 digests can enter direct installation. Valve releases without binary assets explain Steam installation and feed the installed-build selector. No refresh silently replaces the selected version.

`CompatManager` uses an explicit valid path, a detected installation, then a managed build. With none available, it queues pinned GE-Proton through `DownloadManager`; completion hashes the archive, extracts in staging, validates the Proton entry point, atomically publishes the folder and selects it. Queue metadata is persistent so interrupted downloads/installations recover. Compatibility archive link deferral is an explicit mode for checksum-verified runtimes; ordinary game extraction keeps its original restrictions.

RAR/7z use the pinned official standalone 7-Zip 26.04 decoder. Technical member metadata is validated first; the decoder streams concatenated file bytes to stdout and never receives a filesystem destination. Node writes validated members, enforces limits and creates checked internal links after regular data writes. An immediate PassThrough consumer prevents losing early stdout when a small archive decoder exits before the first destination file opens. Archive signatures recognize files even when a host omits their extension.

## Indexing

`Discovery` crawls each enabled source while the Store is open:

1. **Reading pages.** `PageFetcher` reads pages over HTTP through three fetcher
   workers, sending the cookies and user agent of the launcher's Firefox, and runs
   `extractPage({ fast: true })` on the HTML with jsdom. Script-rendered pages,
   gated pages and sites whose recipe says so are read in Firefox instead
   (waiting for single-page apps to settle). Requests are paced per registrable
   domain; HTTP 429 doubles the spacing and retries, successes relax it again.
2. **Learning a site.** On a source's first listing page, `LocalGameAgent.learnListing`
   asks the model (text only, no thinking) whether the layout detector's repeated
   group is games and which links list more games. `site-recipe.ts` turns the answer
   into host/path patterns; later pages match them without a model call. Structural
   pagination (`/page/N`, `?page=N`, "Next") is always followed. A recipe that stops
   matching is re-learned.
3. **Verifying games.** Confirmed cards are stored and cover-checked in one
   checkpointed transaction, then a background stream reads game pages six at a
   time. Structured data (JSON-LD, OpenGraph, page title) identifies the game; the
   model reads the page only when structure is ambiguous.
4. **Human checks.** One gated game page is skipped and retried later; three in a
   row, or a gated listing page, set the source aside for the user while other
   sources continue. The page is re-checked automatically every five minutes and
   when the Store reopens, skipped automatically after two failed re-checks, or
   skipped from the drawer ("Skip this page").
5. **New games.** Indexed sources are re-checked every `crawlRefreshHours`. Re-checks
   stop after two listing pages with nothing new; a full walk runs weekly.

The cursor (pending/visited listing URLs, page count, retry state) and the recipe
persist in SQLite, so leaving the Store or restarting resumes where it stopped.

## Local AI

One model, Fara1.5-9B (Q4_K_M + f16 vision projector, downloaded on demand and
SHA-256 verified), serves every role: browsing, page analysis and file decisions,
so llama-server keeps a single model resident. It is driven exactly like
Microsoft's reference harness (github.com/microsoft/fara): the verbatim system
prompt in `src/shared/fara15-system-prompt.json`, screenshot-first observation
turns ("Current URL: … Here is the next screenshot. Think about what to do
next."), text observations instead of tool messages, the last three screenshots,
normalized 0–1000 coordinates and temperature 0. JSON questions pass
`think: false`. Opening the Store warms the model (one tiny generation compiles
the GPU pipelines). Installs on the older Fara4B/Holo/Qwen team switch to the
single model once it is verified; other catalog models remain selectable.

## Content classifier

The fp16 ViT NSFW classifier runs through onnxruntime's bundled WebGPU backend
(about 35 ms per image on an RTX 3070 Laptop), falling back to the CPU with the
same model. Against the fp32 reference it differs by at most 0.002; the earlier
int8 build flipped 4 of 40 verdicts. Changing `CLASSIFIER_VERSION` re-checks
stored ratings.
