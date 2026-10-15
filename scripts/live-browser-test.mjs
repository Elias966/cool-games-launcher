#!/usr/bin/env node
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(process.argv[2] ?? '/tmp/cgl-live-browser-test');
mkdirSync(scratch, { recursive: true });
rmSync(join(scratch, 'result.json'), { force: true });
await build({entryPoints:[join(root, 'scripts/live-browser-test.ts')],outfile:join(root, 'out/live-browser-test.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],alias:{'@shared':join(root,'src/shared')}});
const electron = join(root, 'node_modules/electron/dist/electron');
const proc = spawn(electron, ['--no-sandbox', join(root, 'out/live-browser-test.cjs')], {stdio:'inherit', env:{...process.env,CGL_TEST_ROOT:root,CGL_TEST_DIR:scratch,XDG_CONFIG_HOME:join(scratch,'config')}});
// Electron teardown can stall after utility-process shutdown on some desktops.
// A result is written only after every assertion and Firefox shutdown passed.
let teardownTimer;
const resultWatch = setInterval(() => {
  if (!existsSync(join(scratch, 'result.json'))) return;
  clearInterval(resultWatch);
  teardownTimer = setTimeout(() => proc.kill('SIGKILL'), 2000);
}, 250);
const deadline = setTimeout(() => proc.kill('SIGKILL'), 180000);
proc.on('exit', (code, signal) => {
  clearInterval(resultWatch); clearTimeout(teardownTimer); clearTimeout(deadline);
  process.exit(code === 0 || signal === 'SIGKILL' && existsSync(join(scratch, 'result.json')) ? 0 : 1);
});
