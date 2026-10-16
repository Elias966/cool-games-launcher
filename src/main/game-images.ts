// The images a Library game can show: its cover (the card) and its background
// (the big image when it is opened). The person picks among the game's Steam
// artwork and screenshots, the download site's artwork and screenshots, or an
// image file of their own.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { GameImages, ImageOptions, SteamMedia } from '@shared/types';
import type { VisibilityPolicy } from '@shared/policy';
import type { AiCacheRepo, CatalogRepo, GamesRepo } from './repos';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'];

/** Image URLs a game may show: Steam's CDN and the like over HTTPS, or the launcher's own artwork cache. */
export function allowedImageUrl(url: string): boolean {
  return /^https:\/\/[^\s"'<>]{4,2000}$/.test(url) || /^cgl-media:\/\/artwork\/[\w.%-]{1,300}$/.test(url);
}

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x && allowedImageUrl(x)))];

export class GameImagesService {
  constructor(private deps: {
    games: Pick<GamesRepo, 'get' | 'update'>;
    catalog: Pick<CatalogRepo, 'get' | 'steamMedia'>;
    policy: () => VisibilityPolicy;
    cache: Pick<AiCacheRepo, 'get' | 'set'>;
    steamMedia: (appid: number) => Promise<SteamMedia | null>;
    artworkDir: string;
  }) {}

  /** Steam artwork for a game: from its Store entry, else looked up (remembered for a week). */
  private async steam(game: { catalogId: number | null; art: { appid: number } | null }): Promise<SteamMedia | null> {
    const fromCatalog = game.catalogId !== null ? this.deps.catalog.steamMedia(game.catalogId) : null;
    if (fromCatalog) return fromCatalog;
    const appid = game.art?.appid;
    if (!appid) return null;
    const key = `steammedia:${appid}`;
    const cached = this.deps.cache.get<SteamMedia>(key, 24 * 7);
    if (cached) return cached;
    const media = await this.deps.steamMedia(appid).catch(() => null);
    if (media) this.deps.cache.set(key, media);
    return media;
  }

  async options(id: number): Promise<ImageOptions> {
    const g = this.deps.games.get(id);
    if (!g) throw new Error('Game not found');
    const media = await this.steam(g);
    const entry = g.catalogId !== null ? this.deps.catalog.get(g.catalogId, this.deps.policy()) : null;
    const own = g.artworkFile ? `cgl-media://artwork/${encodeURIComponent(g.artworkFile)}` : null;
    const shots = [...(media?.screenshots ?? []), ...(entry?.screenshots ?? [])];
    return {
      covers: uniq([g.images.cover, media?.capsule, media?.header, g.art?.capsule, entry?.artwork, own, ...shots]),
      heroes: uniq([g.images.hero, media?.hero, g.art?.hero, media?.background, ...shots, media?.header, entry?.artwork, own]),
    };
  }

  /** Uses `url` for the game's cover or background; null goes back to the default. */
  set(id: number, which: keyof GameImages, url: string | null): GameImages {
    const g = this.deps.games.get(id);
    if (!g) throw new Error('Game not found');
    if (url !== null && !allowedImageUrl(url)) throw new Error('That image cannot be used.');
    const images = { ...g.images, [which]: url };
    this.deps.games.update(id, { images });
    return images;
  }

  /** Copies an image file into the artwork cache and uses it. */
  fromFile(id: number, which: keyof GameImages, file: string): GameImages {
    const ext = extname(file).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error('Choose an image file (JPG, PNG, WebP, GIF or AVIF).');
    mkdirSync(this.deps.artworkDir, { recursive: true });
    const name = `custom-${createHash('sha256').update(`${id}:${which}:${file}:${Date.now()}`).digest('hex').slice(0, 20)}.${ext === 'jpeg' ? 'jpg' : ext}`;
    copyFileSync(file, join(this.deps.artworkDir, name));
    return this.set(id, which, `cgl-media://artwork/${name}`);
  }
}
