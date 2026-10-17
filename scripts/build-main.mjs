#!/usr/bin/env node
// Bundles the Electron main process, preload script and utility-process
// workers with esbuild. Native or WASM-loading packages stay external and are
// shipped in node_modules by electron-builder.
import './build-ooz.mjs';
import { build, context } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', 'onnxruntime-node', 'wasm-vips', 'selenium-webdriver', 'jsdom'],
  alias: { '@shared': resolve(root, 'src/shared') },
  define: { 'process.env.CGL_DEV': JSON.stringify(watch ? '1' : '') },
};

const configs = [
  { ...common, entryPoints: { index: resolve(root, 'src/main/index.ts') }, outdir: resolve(root, 'out/main') },
  { ...common, entryPoints: { index: resolve(root, 'src/preload/index.ts') }, outdir: resolve(root, 'out/preload') },
  {
    ...common,
    entryPoints: {
      inference: resolve(root, 'src/workers/inference.ts'),
      browser: resolve(root, 'src/workers/browser.ts'),
      downloads: resolve(root, 'src/workers/downloads.ts'),
      install: resolve(root, 'src/workers/install.ts'),
      fetcher: resolve(root, 'src/workers/fetcher.ts'),
      artwork: resolve(root, 'src/workers/artwork.ts'),
    },
    outdir: resolve(root, 'out/workers'),
  },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
