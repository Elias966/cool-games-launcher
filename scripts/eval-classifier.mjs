#!/usr/bin/env node
// Measures the bundled NSFW classifier on a labelled image folder, through the
// exact preprocessing the app uses (src/workers/classifier.ts).
//
//   node scripts/eval-classifier.mjs <dataset-dir> [--threshold 0.5] [--json out.json]
//
// Layout: <dataset-dir>/<label>/<style>/*.{jpg,jpeg,png,webp,gif}
//   label: safe | adult
//   style: any name, e.g. photo, illustration, anime, pixel
// A flat <label>/*.jpg layout is also accepted (style "all").
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dataset = args.find((a) => !a.startsWith('--'));
const threshold = Number(args[args.indexOf('--threshold') + 1] || 0.5) || 0.5;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const model = join(root, 'vendor/models/nsfw-vit-fp16.onnx');
if (!dataset || !existsSync(dataset)) {
  console.error('usage: node scripts/eval-classifier.mjs <dataset-dir> [--threshold 0.5] [--json out.json]');
  process.exit(2);
}

// Bundle the TypeScript classifier module so this script needs no TS tooling at run time.
// Written inside the project so the bundle resolves node_modules.
const tmp = join(root, 'out', 'eval');
await build({ entryPoints: [join(root, 'src/workers/classifier.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(tmp, 'classifier.cjs'), external: ['onnxruntime-node', 'wasm-vips'], logLevel: 'error' });
const require = createRequire(join(root, 'package.json'));
const { createClassifier } = require(join(tmp, 'classifier.cjs'));
const classifier = await createClassifier(model, 4);

const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const samples = [];
for (const label of readdirSync(dataset)) {
  const ldir = join(dataset, label);
  if (!statSync(ldir).isDirectory() || !['safe', 'adult'].includes(label)) continue;
  for (const entry of readdirSync(ldir)) {
    const p = join(ldir, entry);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) if (IMG.has(extname(f).toLowerCase())) samples.push({ label, style: entry, path: join(p, f) });
    } else if (IMG.has(extname(entry).toLowerCase())) samples.push({ label, style: 'all', path: p });
  }
}
if (!samples.length) {
  console.error('No images found.');
  process.exit(1);
}

const results = [];
const times = [];
for (const s of samples) {
  const t = performance.now();
  try {
    const [score] = await classifier.score(readFileSync(s.path));
    times.push(performance.now() - t);
    results.push({ ...s, score });
  } catch (e) {
    results.push({ ...s, score: null, error: String(e.message ?? e) });
  }
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const styles = [...new Set(results.map((r) => r.style))].sort();
const rows = [];
for (const style of [...styles, '(all)']) {
  const rs = results.filter((r) => style === '(all)' || r.style === style);
  const safe = rs.filter((r) => r.label === 'safe' && r.score !== null);
  const adult = rs.filter((r) => r.label === 'adult' && r.score !== null);
  const fp = safe.filter((r) => r.score >= threshold).length;
  const tp = adult.filter((r) => r.score >= threshold).length;
  const failed = rs.filter((r) => r.score === null).length;
  rows.push({ style, safe: safe.length, adult: adult.length, falsePositiveRate: pct(fp, safe.length), recall: pct(tp, adult.length), missedAdult: adult.length - tp, failed });
}
console.log(`\nThreshold ${threshold} — ${results.length} images`);
console.table(rows);

console.log('Threshold sweep (all styles):');
const sweep = [];
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  const safe = results.filter((r) => r.label === 'safe' && r.score !== null);
  const adult = results.filter((r) => r.label === 'adult' && r.score !== null);
  sweep.push({ threshold: t, falsePositiveRate: pct(safe.filter((r) => r.score >= t).length, safe.length), recall: pct(adult.filter((r) => r.score >= t).length, adult.length) });
}
console.table(sweep);
times.sort((a, b) => a - b);
console.log(`Latency per image: median ${times[Math.floor(times.length / 2)].toFixed(0)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(0)} ms (4 threads)`);

const worst = results.filter((r) => r.score !== null && ((r.label === 'safe' && r.score >= threshold) || (r.label === 'adult' && r.score < threshold)));
if (worst.length) {
  console.log('\nMisclassified:');
  for (const w of worst) console.log(`  ${w.label}/${w.style}  ${w.score.toFixed(3)}  ${w.path}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ threshold, rows, sweep, results }, null, 2));
