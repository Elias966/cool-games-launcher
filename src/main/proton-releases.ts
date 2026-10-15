import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProtonRelease, ProtonReleaseList } from '@shared/types';

export const PROTON_PROVIDERS = [
  { id: 'valve', name: 'Valve Proton (official)', repo: 'ValveSoftware/Proton' },
  { id: 'ge', name: 'GE-Proton', repo: 'GloriousEggroll/proton-ge-custom' },
  { id: 'cachyos', name: 'CachyOS Proton', repo: 'CachyOS/proton-cachyos' },
] as const;
export const RELEASE_REFRESH_MS = 15 * 60_000;

/** Accept published baseline x86_64 builds, never source archives or v3/v4 builds. */
export function parseReleases(providerId: string, data: unknown): ProtonRelease[] {
  const provider = PROTON_PROVIDERS.find((p) => p.id === providerId);
  if (!provider || !Array.isArray(data)) throw new Error('Invalid Proton release response');
  return data.filter((r) => r && !r.draft && typeof r.tag_name === 'string').slice(0, 30).map((r) => {
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const asset = assets.find((a: any) => typeof a.name === 'string' && /\.tar\.(?:gz|xz)$/.test(a.name) &&
      !/aarch64|arm64|x86_64_v[234]|debug|source/i.test(a.name) &&
      (provider.id !== 'cachyos' || /slr.*x86_64\.tar\.xz$/.test(a.name)));
    const url = typeof asset?.browser_download_url === 'string' && asset.browser_download_url.startsWith(`https://github.com/${provider.repo}/releases/download/`) ? asset.browser_download_url : null;
    const sha256 = typeof asset?.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null;
    const tag = r.tag_name.slice(0, 120);
    return {
      id: `${provider.id}:${tag}`,
      provider: provider.id,
      version: tag,
      name: typeof r.name === 'string' ? r.name.slice(0, 160) : tag,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
      prerelease: !!r.prerelease,
      pageUrl: `https://github.com/${provider.repo}/releases/tag/${encodeURIComponent(tag)}`,
      url,
      sha256,
      size: Number.isSafeInteger(asset?.size) && asset.size > 0 ? asset.size : null,
      unavailableReason: !url ? (provider.id === 'valve' ? 'Official binaries are distributed through Steam. Install in Steam, then select the detected installation below.' : 'No compatible baseline x86_64 archive is published for this release.') : !sha256 ? 'This release has no published SHA-256 asset digest; use a verified release or import an existing installation.' : null,
    };
  });
}

export class ProtonReleases {
  private entries = new Map<string, ProtonRelease[]>();
  private etags = new Map<string, string>();
  private checked = new Map<string, number>();
  private errors = new Map<string, string>();
  private inflight: Promise<ProtonReleaseList> | null = null;

  constructor(private cacheFile: string, private request: typeof fetch = fetch) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      for (const p of PROTON_PROVIDERS) {
        // Cached responses are parsed again, so edited cache files cannot add providers or arbitrary URLs.
        if (Array.isArray(saved[p.id]?.raw)) this.entries.set(p.id, parseReleases(p.id, saved[p.id].raw));
        if (typeof saved[p.id]?.etag === 'string') this.etags.set(p.id, saved[p.id].etag);
        if (typeof saved[p.id]?.checked === 'number') this.checked.set(p.id, saved[p.id].checked);
      }
    } catch { /* first launch or invalid cache */ }
  }

  snapshot(): ProtonReleaseList {
    return {
      providers: PROTON_PROVIDERS.map((p) => ({ id: p.id, name: p.name, checkedAt: this.checked.has(p.id) ? new Date(this.checked.get(p.id)!).toISOString() : null, error: this.errors.get(p.id) ?? null })),
      releases: PROTON_PROVIDERS.flatMap((p) => this.entries.get(p.id) ?? []),
    };
  }

  async refresh(force = false): Promise<ProtonReleaseList> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load(force).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(force: boolean) {
    let saved: Record<string, any>;
    try { saved = JSON.parse(readFileSync(this.cacheFile, 'utf8')); } catch { saved = {}; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    await Promise.all(PROTON_PROVIDERS.map(async (p) => {
      const elapsed = Date.now() - (this.checked.get(p.id) ?? 0);
      if (elapsed >= 0 && elapsed < (force ? 60_000 : RELEASE_REFRESH_MS)) return;
      try {
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Cool-Games-Launcher', 'X-GitHub-Api-Version': '2022-11-28' };
        if (this.etags.has(p.id)) headers['If-None-Match'] = this.etags.get(p.id)!;
        const response = await this.request(`https://api.github.com/repos/${p.repo}/releases?per_page=30`, { headers, signal: AbortSignal.timeout(15000) });
        if (response.status !== 304) {
          if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'Release API rate limit reached. Cached versions remain available; refresh later.' : `Release API returned HTTP ${response.status}.`);
          const raw = await response.json();
          this.entries.set(p.id, parseReleases(p.id, raw));
          const etag = response.headers.get('etag');
          if (etag) this.etags.set(p.id, etag);
          saved[p.id] = { raw, etag, checked: Date.now() };
        }
        this.checked.set(p.id, Date.now());
        if (saved[p.id]) saved[p.id].checked = this.checked.get(p.id);
        this.errors.delete(p.id);
      } catch (e) {
        this.errors.set(p.id, `Could not refresh: ${(e as Error).message}`);
        // Back off failures too; a disconnected machine must not hammer the API.
        this.checked.set(p.id, Date.now());
      }
    }));
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile + '.tmp', JSON.stringify(saved));
      renameSync(this.cacheFile + '.tmp', this.cacheFile);
    } catch { /* read-only cache: keep the in-memory list */ }
    return this.snapshot();
  }

  find(id: string): ProtonRelease | null {
    return this.snapshot().releases.find((r) => r.id === id) ?? null;
  }
}
