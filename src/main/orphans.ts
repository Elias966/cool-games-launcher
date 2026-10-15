// Stops helpers a previous launcher run left behind (after a crash or a forced
// quit): a stray llama-server keeps ~6 GB of VRAM so the model no longer fits
// on the GPU, and a stray Firefox locks the browser profile. Only one launcher
// instance can run (single-instance lock), so any such process is an orphan.
import { readdirSync, readFileSync } from 'node:fs';

export function reapOrphans(markers: { runtimeDir: string; browserProfile: string }): number {
  let killed = 0;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let cmd: string;
    try { cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    const ours =
      cmd.includes(`${markers.runtimeDir}/llama-`) ||
      cmd.includes(`-profile ${markers.browserProfile}`) ||
      // AppImages mount at a new path each run, so match the bundled binary by name.
      /\/vendor\/geckodriver\/geckodriver --allow-system-access/.test(cmd);
    if (!ours) continue;
    try { process.kill(Number(name), 'SIGKILL'); killed++; } catch { /* already gone */ }
  }
  if (killed) console.log(`[main] stopped ${killed} leftover helper process(es) from a previous run`);
  return killed;
}
