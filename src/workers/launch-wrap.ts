// Per-game launch options turned into a command line: Gamescope, MangoHud,
// GameMode and environment variables around the game (or umu-run).

export interface LaunchExtras {
  gamescope: boolean;
  resolution: string | null;
  upscale: 'off' | 'fsr' | 'nis';
  fpsLimit: number | null;
  mangohud: boolean;
  gamemode: boolean;
  nvapi: boolean;
  wined3d: boolean;
  env: string;
  tools: { gamescope: string | null; mangohud: string | null; gamemode: string | null; mangohudLayer?: boolean };
}

/** Never let user variables replace what the launcher itself relies on. */
const PROTECTED_ENV = /^(?:WINEPREFIX|PROTONPATH|GAMEID|STORE|PATH|HOME|LD_PRELOAD|LD_LIBRARY_PATH)$/;

/**
 * Wraps a launch command with the game's options, outermost first:
 * gamemoderun → gamescope … -- → mangohud → the game (or umu-run).
 */
export function applyExtras(base: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }, o: LaunchExtras | undefined, proton: boolean) {
  if (!o) return base;
  const env = { ...base.env };
  for (const line of o.env.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && !PROTECTED_ENV.test(m[1])) env[m[1]] = m[2].trim();
  }
  if (proton && o.nvapi) { env.PROTON_ENABLE_NVAPI = '1'; env.DXVK_ENABLE_NVAPI = '1'; }
  if (proton && o.wined3d) env.PROTON_USE_WINED3D = '1';
  let cmd = base.cmd;
  let args = [...base.args];
  // The launcher's current MangoHud is a Vulkan layer switched on by MANGOHUD=1 (Proton games draw
  // through Vulkan); the system's mangohud wrapper stays for native games, whose OpenGL needs its preload.
  if (o.mangohud && o.tools.mangohudLayer && (proton || !o.tools.mangohud)) env.MANGOHUD = '1';
  else if (o.mangohud && o.tools.mangohud) { env.MANGOHUD = '1'; args = [cmd, ...args]; cmd = o.tools.mangohud; }
  const scope = o.gamescope && o.tools.gamescope;
  // Without Gamescope the frame cap goes through DXVK / VKD3D (Direct3D games under Proton).
  if (o.fpsLimit && !scope) { env.DXVK_FRAME_RATE = String(o.fpsLimit); env.VKD3D_FRAME_RATE = String(o.fpsLimit); }
  if (scope) {
    const g: string[] = ['-f'];
    const res = /^(\d+)x(\d+)$/.exec(o.resolution ?? '');
    if (res) {
      g.push('-W', res[1], '-H', res[2]);
      // Upscaling renders the game at about two thirds of the output and scales it up.
      if (o.upscale !== 'off') g.push('-w', String(Math.round(Number(res[1]) * 2 / 3)), '-h', String(Math.round(Number(res[2]) * 2 / 3)), '-F', o.upscale);
    } else if (o.upscale !== 'off') g.push('-F', o.upscale);
    if (o.fpsLimit) g.push('-r', String(o.fpsLimit));
    args = [...g, '--', cmd, ...args];
    cmd = o.tools.gamescope!;
  }
  if (o.gamemode && o.tools.gamemode) { args = [cmd, ...args]; cmd = o.tools.gamemode; }
  return { cmd, args, env };
}
