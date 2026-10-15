#!/usr/bin/env node
// Writes SHA256SUMS for every artifact in release/.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const dir = join(process.cwd(), 'release');
const lines = [];
for (const f of readdirSync(dir).filter((f) => /\.(AppImage|tar\.gz|zip)$/.test(f)).sort()) {
  if (!statSync(join(dir, f)).isFile()) continue;
  const h = createHash('sha256');
  await pipeline(createReadStream(join(dir, f)), h);
  lines.push(`${h.digest('hex')}  ${f}`);
}
writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
