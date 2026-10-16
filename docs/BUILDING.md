# Building

## Prerequisites

- Linux x86_64, Node.js 24+, npm 11+
- `tar`, `xz`, `bzip2`, `dpkg-deb` (vendor extraction and tar.xz/tar.bz2 game archives)
- Python 3 (tests build crafted archives with it; umu-launcher needs it at run time)
- About 12 GB free disk space (vendor cache, extracted vendor, AppImage)

## Steps

```bash
npm ci
```

Fetch the pinned third-party components — Firefox ESR, geckodriver, uBlock
Origin, llama.cpp (CPU and Vulkan), the ONNX content classifier, umu-launcher,
7-Zip, the GCC OpenMP runtime, license texts and a static AppImage build runtime.
Every file is checked against the SHA-256 in `scripts/vendor-manifest.json`;
downloads resume if interrupted. Agent GGUF weights and matching vision
projectors are excluded from the AppImage. Users download them in Settings →
Local AI after installation.

```bash
npm run vendor
```

Run from source:

```bash
npm start
```

Development loop (rebuilds on change, restarts Electron when main changes):

```bash
npm run dev
```

Checks:

```bash
npm run typecheck
```

```bash
npm test
```

Build the AppImage (`release/Cool-Games-Launcher-<version>-x86_64.AppImage`,
with all agent weights excluded) and its checksums:

```bash
npm run dist
```

```bash
npm run checksums
```

`npm run dist` runs the typecheck and tests, bundles main/preload/workers with
esbuild and the renderer with Vite, regenerates `THIRD_PARTY_NOTICES.md`, and
packages with electron-builder, replaces its FUSE 2 runtime with the pinned static runtime while preserving the SquashFS payload, and generates checksums. `scripts/after-pack.cjs` installs the launcher
wrapper that keeps Chromium's sandbox wherever user namespaces are available.

## Updating vendor components

Edit `scripts/vendor-manifest.json` (URL, version, SHA-256 together), run
`npm run vendor`, then `npm run notices`. If the classifier changes, bump
`CLASSIFIER_VERSION` in `src/main/ai.ts` so existing ratings are recomputed.

To produce the classifier ONNX yourself instead of downloading the author's
export, use Hugging Face Optimum:

```bash
optimum-cli export onnx --model AdamCodd/vit-base-nsfw-detector --task image-classification vit-nsfw-onnx/
```

then quantise to int8 (`optimum-cli onnxruntime quantize --avx2`) and update the
manifest digest.

## Icons

`build/icon-source.png` (1024 px, transparent corners) is the source. Re-create the PNGs with:

```bash
npm run icons
```

## Layout

```
src/shared     types, IPC contract, policy, URL helpers, in-page DOM extraction
src/main       Electron main process (services, repositories, IPC, protocols)
src/preload    the renderer bridge (window.cgl)
src/workers    utility processes: inference, browser, downloads, install
src/renderer   React UI, Three.js scene, styles
scripts        vendor fetch, builds, notices, icons, classifier evaluation
tests          Vitest suites
```

## Linux compatibility

The bundled llama.cpp runtime sets a glibc 2.34 minimum. The OpenMP runtime is bundled for both CPU and Vulkan inference; no host libgomp installation is needed. Desktop GTK/NSS/graphics libraries, Python 3 for umu, and a suitable GPU driver for hardware acceleration remain host requirements. The AppImage targets x86_64, not musl or ARM.

Rootless smoke tests use `python3`, `bwrap`, `Xvfb`, a C compiler, network access and substantial scratch disk space. They download digest-verified official OCI root filesystems and install desktop libraries only inside those scratch directories:

```bash
scripts/distro-smoke.sh "$PWD/release/Cool-Games-Launcher-0.2.2-x86_64.AppImage" /tmp/cgl-distro-smoke
```

The disposable single-UID test rootfs skips service-user RPM scriptlets and file capabilities. No host package manager or root password is used. This checks userspace compatibility on the host kernel; it does not certify every GPU, desktop, kernel or game.
