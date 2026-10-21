// Newer DLSS (NVIDIA) and FSR 4 (AMD) for Windows games under Proton. Proton
// downloads the libraries itself when asked through environment variables:
// GE-Proton's PROTON_DLSS_UPGRADE and Valve's NGX updater fetch NVIDIA's DLSS
// files, DXVK-NVAPI picks the DLSS model (render preset), and GE-Proton's
// PROTON_FSR4_UPGRADE fetches AMD's FSR 4 library. The versions on offer come
// from the same list GE-Proton downloads from, so new ones appear by themselves.
import type { GraphicsVersions, Settings } from '@shared/types';

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export const MANIFEST_URL = 'https://loathingkernel.github.io/proton-upscalers/manifest.json';
export const NR_AMD_RELEASES = 'https://api.github.com/repos/danielblnc/DLSS-NR-on-AMD/releases/latest';
export const NR_AMD_PAGE = 'https://github.com/danielblnc/DLSS-NR-on-AMD/releases/latest';

export type UpscalerSettings = Pick<Settings, 'dlssUpgrade' | 'dlssVersion' | 'dlssPreset' | 'fsr4Upgrade' | 'fsr4Version'>;

/** Environment lines (KEY=VALUE) for a Proton game; the game's own lines are applied after and win. */
export function upscalerEnv(s: UpscalerSettings): string[] {
  const out: string[] = [];
  if (s.dlssUpgrade) {
    out.push('PROTON_ENABLE_NVAPI=1');
    if (s.dlssVersion === 'latest') {
      // GE-Proton fetches the newest DLSS files; Valve's Proton uses NVIDIA's own updater.
      out.push('PROTON_DLSS_UPGRADE=1', 'PROTON_ENABLE_NGX_UPDATER=1');
    } else out.push(`PROTON_DLSS_UPGRADE=${s.dlssVersion}`);
    if (s.dlssPreset !== 'game') {
      out.push('DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE=on', `DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE_RENDER_PRESET_SELECTION=render_preset_${s.dlssPreset}`);
    }
  }
  if (s.fsr4Upgrade) out.push(`PROTON_FSR4_UPGRADE=${s.fsr4Version === 'latest' ? '1' : s.fsr4Version}`);
  return out;
}

interface ManifestEntry { version?: string; is_dev_file?: boolean }

/** Release versions newest first, without development builds or repeats. */
export function releaseVersions(entries: ManifestEntry[] | undefined, keep = 10): string[] {
  const seen = new Set<string>();
  for (const e of entries ?? []) if (e.version && !e.is_dev_file && /^[\d.]+$/.test(e.version)) seen.add(e.version);
  const parts = (v: string) => v.split('.').map(Number);
  return [...seen].sort((a, b) => {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  }).slice(0, keep);
}

export interface VersionDeps {
  fetch: Fetch;
  cache: { get<T>(key: string, maxAgeHours?: number): T | null; set(key: string, value: unknown): void };
}

export class UpscalerVersions {
  constructor(private deps: VersionDeps) {}

  private async json<T>(url: string, key: string, hours: number, refresh: boolean): Promise<T | null> {
    const hit = refresh ? null : this.deps.cache.get<{ v: T | null }>(key, hours);
    if (hit) return hit.v;
    let v: T | null = null;
    try {
      const res = await this.deps.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      v = res.ok ? ((await res.json()) as T) : null;
    } catch { v = null; }
    // A failed check is not remembered, so the next one tries again.
    if (v !== null) this.deps.cache.set(key, { v });
    return v ?? this.deps.cache.get<{ v: T | null }>(key)?.v ?? null;
  }

  async list(refresh = false): Promise<GraphicsVersions> {
    const [manifest, nr] = await Promise.all([
      this.json<Record<string, ManifestEntry[]>>(MANIFEST_URL, 'upscalers:manifest', 12, refresh),
      this.json<{ tag_name?: string; assets?: Array<{ name?: string }> }>(NR_AMD_RELEASES, 'upscalers:nr-amd', 12, refresh),
    ]);
    // Its releases are Windows installers so far; a Linux build is spotted by its file name.
    const assets = (nr?.assets ?? []).map((a) => a.name ?? '');
    return {
      dlss: releaseVersions(manifest?.dlss),
      fsr4: releaseVersions(manifest?.fsr_40_drv),
      nrAmd: nr?.tag_name ? { version: nr.tag_name, linux: assets.some((n) => /linux|\.appimage$|\.tar\.(gz|xz|zst)$|\.so$/i.test(n)), page: NR_AMD_PAGE } : null,
    };
  }
}
