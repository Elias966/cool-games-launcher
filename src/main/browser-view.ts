// The Store's browser drawer: streams page snapshots of the interactive
// Firefox window to the renderer and forwards the user's input. With NSFW
// hidden, a frame is shown only after its images (and the frame itself) pass
// the classifier; anything unknown or failed is masked.
import type { BrowserClient, BrowserContext, SnapshotResult } from './browser-client';
import type { AiService } from './ai';
import type { PolicyService } from './policy-service';
import type { CatalogRepo } from './repos';
import type { StoreSession } from './store-session';
import { publish } from './bus';
import { NSFW_IMAGE_THRESHOLD } from '@shared/policy';
import { canonicalUrl } from '@shared/urls';

interface Frame {
  seq: number;
  png: Buffer;
  revision: number;
}

export class BrowserView {
  private open = false;
  private context: BrowserContext = 'interactive';
  private loop: Promise<void> | null = null;
  private seq = 0;
  /** Recently approved frames; the renderer fetches them by sequence number. */
  private frames: Frame[] = [];
  private kick: (() => void) | null = null;
  private visible = true;
  private mediaCache = new Map<string, number | null>();

  constructor(
    private browser: BrowserClient,
    private ai: AiService,
    private policy: PolicyService,
    private catalog: CatalogRepo,
    private session: StoreSession,
  ) {
    policy.on('changed', () => {
      // Drop any frame approved under the old policy and re-evaluate.
      this.frames = [];
      this.mediaCache.clear();
      this.refresh();
    });
    session.on('leave', () => this.close('You left the Store'));
  }

  get activeContext(): BrowserContext { return this.context; }

  get isOpen() {
    return this.open;
  }

  setWindowVisible(v: boolean) {
    this.visible = v;
    if (v) this.refresh();
  }

  async openUrl(url: string) {
    if (!this.session.active) throw new Error('The browser is available in the Store');
    this.show();
    await this.browser.navigate('interactive', url);
    this.refresh();
  }

  /** Open a source on a fresh browser, while preserving a page the user already opened. */
  async showDefault(url: string | null) {
    if (!this.session.active || this.open) return;
    const shot = await this.browser.snapshot(this.context, false);
    if (!this.session.active) return;
    if (url && !/^https?:/i.test(shot.url)) {
      await this.browser.navigate(this.context, url);
    }
    if (this.session.active) this.show(this.context);
  }

  /** Shows the drawer without navigating (the resolver drives it). */
  show(context: BrowserContext = 'interactive') {
    if (!this.session.active) return;
    if (context !== this.context) {
      this.context = context;
      this.frames = [];
      this.mediaCache.clear();
    }
    this.open = true;
    if (!this.loop) this.loop = this.run().finally(() => (this.loop = null));
    this.refresh();
  }

  releaseDiscovery() {
    if (this.context !== 'discovery') return;
    this.close();
    this.context = 'interactive';
  }

  close(reason: string | null = null) {
    if (!this.open) return;
    this.open = false;
    this.frames = [];
    this.kick?.();
    publish('browser:closed', { reason });
  }

  refresh() {
    this.kick?.();
  }

  currentFrame(seq: number): Buffer | null {
    const f = this.frames.find((x) => x.seq === seq);
    if (!f || f.revision !== this.policy.policy().revision) return null;
    return f.png;
  }

  private async run() {
    while (this.open) {
      if (this.visible) {
        try {
          await this.capture();
        } catch (e) {
          if (this.open) console.warn('[browser-view]', (e as Error).message);
        }
      }
      // ~2 frames per second while open, or immediately after input.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.visible ? 450 : 2000);
        this.kick = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.kick = null;
    }
  }

  private async capture() {
    const policyAtStart = this.policy.policy();
    const context = this.context;
    const shot = await this.browser.snapshot(context, true);
    if (!this.open) return;
    this.lastSize = { w: shot.w || 1280, h: shot.h || 800 };
    const png = Buffer.from(shot.png, 'base64');
    const verdict = await this.evaluate(shot, png, policyAtStart.showNsfw);
    const policy = this.policy.policy();
    // A verdict computed under an older policy is never published.
    if (policy.revision !== policyAtStart.revision || !this.open || context !== this.context) return;

    const seq = ++this.seq;
    const masked = !policy.showNsfw && verdict.mask;
    if (masked) this.frames = [];
    else this.frames = [...this.frames.slice(-2), { seq, png, revision: policy.revision }];
    publish('browser:snapshot', {
      seq,
      url: shot.url,
      title: shot.title,
      image: masked ? null : `cgl-media://snapshot/${seq}`,
      masked,
      maskReason: masked ? verdict.reason : null,
      width: shot.w,
      height: shot.h,
      loading: shot.loading,
      nsfw: verdict.adult,
      policyRevision: policy.revision,
    });
  }

  /** Classifies the visible media regions and the whole frame. */
  private async evaluate(shot: SnapshotResult, png: Buffer, showNsfw: boolean): Promise<{ mask: boolean; adult: boolean; reason: string | null }> {
    const pageRating = this.catalog.ratingOfPage(canonicalUrl(shot.url) ?? shot.url);
    if (pageRating === 'adult') return { mask: true, adult: true, reason: 'This page belongs to an adult game.' };
    if (shot.adultSignals.length) return { mask: true, adult: true, reason: 'This page is labelled as adult content.' };

    const dpr = shot.dpr || 1;
    const regions: Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
    for (const m of shot.media.slice(0, 6)) {
      const key = `${m.src}|${Math.round(m.rect.w / 32)}x${Math.round(m.rect.h / 32)}`;
      if (this.mediaCache.has(key)) continue;
      regions.push({ key, x: m.rect.x * dpr, y: m.rect.y * dpr, w: m.rect.w * dpr, h: m.rect.h * dpr });
    }
    let scores: number[] = [];
    let wholeScore: number | null = null;
    try {
      // When adult content is allowed, classification still runs (for the badge) but skips the whole-frame pass.
      const includeWhole = !showNsfw;
      if (regions.length || includeWhole) {
        scores = await this.ai.classify({ base64: png.toString('base64'), regions: regions.map(({ x, y, w, h }) => ({ x, y, w, h })), includeWhole });
        if (includeWhole) wholeScore = scores.shift() ?? null;
      }
    } catch {
      return { mask: true, adult: false, reason: 'The page could not be content-checked.' };
    }
    regions.forEach((r, i) => this.mediaCache.set(r.key, Number.isFinite(scores[i]) ? scores[i] : null));
    if (this.mediaCache.size > 600) this.mediaCache.clear();

    let worst = wholeScore ?? 0;
    let unknown = !showNsfw && wholeScore === null;
    for (const m of shot.media.slice(0, 6)) {
      const key = `${m.src}|${Math.round(m.rect.w / 32)}x${Math.round(m.rect.h / 32)}`;
      const s = this.mediaCache.get(key);
      if (s === null || s === undefined) {
        // Regions too small to crop are covered by the whole-frame score.
        if (s === null && m.rect.w >= 24 && m.rect.h >= 24) unknown = true;
        continue;
      }
      worst = Math.max(worst, s);
    }
    const adult = worst >= NSFW_IMAGE_THRESHOLD;
    if (adult) return { mask: true, adult, reason: 'Images on this page look like adult content.' };
    if (unknown) return { mask: true, adult, reason: 'Some images could not be content-checked.' };
    return { mask: false, adult, reason: null };
  }

  // --- input forwarding (viewport-relative 0..1 coordinates) ---------------

  private lastSize = { w: 1280, h: 800 };

  async click(x: number, y: number, button: 'left' | 'middle' | 'right') {
    await this.browser.pointer(this.context, x * this.lastSize.w, y * this.lastSize.h, button);
    this.refresh();
  }

  async scroll(x: number, y: number, dx: number, dy: number) {
    await this.browser.scroll(this.context, x * this.lastSize.w, y * this.lastSize.h, dx, dy);
    this.refresh();
  }

  async type(text: string) {
    await this.browser.type(this.context, { text });
    this.refresh();
  }

  async key(key: string) {
    await this.browser.type(this.context, { key });
    this.refresh();
  }

  async history(action: 'back' | 'forward' | 'reload') {
    await this.browser.history(this.context, action);
    this.refresh();
  }
}
