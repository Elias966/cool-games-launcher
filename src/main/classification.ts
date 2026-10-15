// Content classification for catalog entries: downloads artwork into the
// cache, runs the ONNX classifier, and combines image and text evidence.
// Any failure leaves the entry `unknown`, which keeps it hidden.
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { combineClassification, textAdultSignals } from '@shared/policy';
import { hostOf } from '@shared/urls';
import type { AiService } from './ai';
import { CLASSIFIER_VERSION } from './ai';
import type { CatalogRepo, ImageClassRepo } from './repos';
import type { HostRateLimiter } from './rate-limit';

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

export class ArtworkCache {
  constructor(
    private dir: string,
    private limiter: HostRateLimiter,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  fileFor(url: string): string | null {
    const base = createHash('sha1').update(url).digest('hex');
    for (const ext of new Set(Object.values(IMAGE_TYPES))) {
      if (existsSync(join(this.dir, `${base}.${ext}`))) return `${base}.${ext}`;
    }
    return null;
  }

  path(file: string): string {
    return join(this.dir, file);
  }

  /** Downloads an image into the cache and returns its file name. */
  async fetch(url: string, referer: string | null, signal?: AbortSignal): Promise<string> {
    const cached = this.fileFor(url);
    if (cached) return cached;
    if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported image URL');
    await this.limiter.wait(`img:${hostOf(url)}`, 400, signal);
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', ...(referer ? { Referer: referer } : {}) },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Image HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) throw new Error(`Not a supported image (${type || 'unknown type'})`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_IMAGE_BYTES) throw new Error('Image too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES || buf.length < 64) throw new Error('Image size out of range');
    const file = `${createHash('sha1').update(url).digest('hex')}.${ext}`;
    writeFileSync(join(this.dir, file), buf);
    return file;
  }
}

export class ClassificationService {
  constructor(
    private ai: AiService,
    private artwork: ArtworkCache,
    private catalog: CatalogRepo,
    private images: ImageClassRepo,
  ) {}

  /** Score for one image URL, cached per classifier version. Null when it could not be classified. */
  async scoreImage(url: string, referer: string | null, signal?: AbortSignal): Promise<{ score: number | null; file: string | null }> {
    const cached = this.images.get(url, CLASSIFIER_VERSION);
    let file: string | null = this.artwork.fileFor(url);
    if (cached && !cached.failed && file) return { score: cached.score, file };
    try {
      file = await this.artwork.fetch(url, referer, signal);
      const [score] = cached && !cached.failed ? [cached.score!] : await this.ai.classify({ path: this.artwork.path(file) }, signal);
      this.images.set(url, CLASSIFIER_VERSION, score);
      return { score, file };
    } catch (e) {
      if (signal?.aborted) throw e;
      this.images.set(url, CLASSIFIER_VERSION, null);
      return { score: null, file };
    }
  }

  /** Classifies a catalog entry and stores its rating. Returns the new rating. */
  async classifyEntry(id: number, signal?: AbortSignal) {
    const raw = this.catalog.raw(id);
    if (!raw) return null;
    const scores: number[] = [];
    let failures = 0;
    // Cover and screenshots download and score concurrently: indexing speed
    // is bounded by this step, since entries stay hidden until rated.
    const shots = raw.screenshots.filter((u) => u !== raw.thumbnailUrl).slice(0, 4);
    const [cover, ...shotResults] = await Promise.all([
      raw.thumbnailUrl ? this.scoreImage(raw.thumbnailUrl, raw.pageUrl, signal) : Promise.resolve(null),
      ...shots.map((url) => this.scoreImage(url, raw.pageUrl, signal)),
    ]);
    const coverFile: string | null = cover?.file ?? null;
    const coverFailed = !!cover && cover.score === null;
    if (cover) {
      if (cover.score === null) failures++;
      else scores.push(cover.score);
    }
    const shotFiles: Array<{ file: string; score: number }> = [];
    for (const r of shotResults) {
      if (!r) continue;
      if (r.score === null) failures++;
      else {
        scores.push(r.score);
        if (r.file) shotFiles.push({ file: r.file, score: r.score });
      }
    }
    // Text signals are stored with a "text:" prefix; everything else is a site-provided label.
    const siteFlags = raw.textSignals.filter((s) => !s.startsWith('text:'));
    const textSignals = [
      ...new Set([
        ...raw.textSignals.filter((s) => s.startsWith('text:')).map((s) => s.slice(5)),
        ...textAdultSignals(raw.title, raw.description, raw.tags.join(', ')),
      ]),
    ];
    const result = combineClassification({ imageScores: scores, imageFailures: failures, textSignals, siteFlags });
    // The cover is what the Store shows: it must classify for a safe rating.
    const rating = result.rating === 'safe' && coverFailed ? 'unknown' : result.rating;
    signal?.throwIfAborted();
    this.catalog.setRating(id, rating, result.score, rating === 'unknown' ? ['cover-unclassified'] : result.reasons, CLASSIFIER_VERSION);
    if (coverFile) this.catalog.setArtwork(id, coverFile);
    this.catalog.setScreenshotFiles(id, shotFiles);
    return rating;
  }
}
