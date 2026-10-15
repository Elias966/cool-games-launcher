#!/usr/bin/env node
// Development loop: rebuilds main/preload/workers and the renderer on change
// and restarts Electron when the main-process bundle changes.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (n) => resolve(root, 'node_modules/.bin', n);
const opts = { cwd: root, stdio: 'inherit' };

spawn(process.execPath, ['scripts/build-main.mjs', '--watch'], opts);
spawn(bin('vite'), ['build', '--watch', '--config', 'vite.config.ts', '--mode', 'development'], opts);

let app = null;
let timer = null;
function restart() {
  if (app) app.kill('SIGTERM');
  app = spawn(bin('electron'), ['.'], { ...opts, env: { ...process.env, CGL_DEBUG: '1' } });
}
setTimeout(restart, 2500);
watch(resolve(root, 'out/main'), () => {
  clearTimeout(timer);
  timer = setTimeout(restart, 400);
});
process.on('SIGINT', () => {
  app?.kill('SIGTERM');
  process.exit(0);
});
