// Persistent launcher log: everything main and its workers print (workers'
// output is forwarded through main) also goes to <data>/logs/launcher.log,
// so a failure on the user's machine leaves evidence. Rotates at 4 MB.
import { createWriteStream, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function startLogFile(dir: string) {
  const file = join(dir, 'launcher.log');
  try { if (existsSync(file) && statSync(file).size > 4 * 1024 * 1024) renameSync(file, file + '.1'); } catch { /* keep logging to the old file */ }
  const out = createWriteStream(file, { flags: 'a' });
  out.on('error', () => undefined);
  out.write(`\n===== ${new Date().toISOString()} launcher start (pid ${process.pid}) =====\n`);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      try { out.write(typeof chunk === 'string' || chunk instanceof Uint8Array ? chunk : String(chunk)); } catch { /* never break logging */ }
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}
