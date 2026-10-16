// Content-visibility policy. Classification always runs; the user's preference
// only decides what may be shown. Unknown (pending or failed) classifications
// are never shown, whatever the preference.
import type { ContentRating } from './types';

export interface VisibilityPolicy {
  showNsfw: boolean;
  revision: number;
  /** Hide games whose cover shows a woman (scored by an image model; unchecked covers wait hidden). */
  hideWomenCovers?: boolean;
  /** Covers scoring at least this are hidden (Strict 0.2, Balanced 0.3). */
  coverThreshold?: number;
}

export const COVER_THRESHOLD = { strict: 0.2, balanced: 0.3 } as const;

/** SQL condition (with a leading AND) for the cover filter on a catalog alias. */
export function coverCondition(policy: Pick<VisibilityPolicy, 'hideWomenCovers' | 'coverThreshold'>, alias = 'c.'): string {
  return policy.hideWomenCovers ? ` AND ${alias}cover_score < ${Number(policy.coverThreshold ?? COVER_THRESHOLD.strict)}` : '';
}

export function coverVisible(score: number | null | undefined, policy: Pick<VisibilityPolicy, 'hideWomenCovers' | 'coverThreshold'>): boolean {
  return !policy.hideWomenCovers || (score !== null && score !== undefined && score < (policy.coverThreshold ?? COVER_THRESHOLD.strict));
}

export function isVisible(rating: ContentRating, policy: Pick<VisibilityPolicy, 'showNsfw'>): boolean {
  if (rating === 'safe') return true;
  if (rating === 'adult') return policy.showNsfw;
  return false;
}

/** Ratings that may be returned by a catalog query under the given policy. */
export function visibleRatings(policy: Pick<VisibilityPolicy, 'showNsfw'>): ContentRating[] {
  return policy.showNsfw ? ['safe', 'adult'] : ['safe'];
}

/** A result produced under `producedAt` may only be published while that revision is current. */
export function isCurrent(producedAt: number, policy: VisibilityPolicy): boolean {
  return producedAt === policy.revision;
}

/** Score threshold above which the image classifier's NSFW probability marks content adult. */
export const NSFW_IMAGE_THRESHOLD = 0.5;

const STRONG_TEXT_SIGNALS = [
  /\bnsfw\b/i,
  /\bhentai\b/i,
  /\bporn(?:o|ographic)?\b/i,
  /\bexplicit sexual\b/i,
  /\bsexual content\b/i,
  /\bnudity\b/i,
  /\beroge\b/i,
  /\bh-?game\b/i,
  /\b18\s*\+(?!\s*months)/i,
  /\badults? only\b/i,
  /\bxxx\b/i,
  /\blewd\b/i,
  /\becchi\b/i,
];

/** Returns the adult-content signals found in free text (title, description, tags). */
export function textAdultSignals(...texts: Array<string | null | undefined>): string[] {
  const hits = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const re of STRONG_TEXT_SIGNALS) {
      const m = t.match(re);
      if (m) hits.add(m[0].toLowerCase().trim());
    }
  }
  return [...hits];
}

export interface ClassificationInput {
  /** NSFW probabilities for each successfully classified image. */
  imageScores: number[];
  /** Number of images that were attempted but could not be classified. */
  imageFailures: number;
  /** Text signals from title/description/tags/site labels. */
  textSignals: string[];
  /** Site-provided explicit adult flags (e.g. RTA label, itch.io NSFW flag). */
  siteFlags: string[];
}

export interface ClassificationResult {
  rating: ContentRating;
  score: number;
  reasons: string[];
}

/**
 * Combines image and text evidence. Any adult evidence wins. A safe rating
 * requires at least one successfully classified image, or — for entries
 * without any artwork — no image failures and no adult text.
 */
export function combineClassification(input: ClassificationInput): ClassificationResult {
  const reasons: string[] = [];
  const maxScore = input.imageScores.length ? Math.max(...input.imageScores) : 0;
  if (input.siteFlags.length) reasons.push(...input.siteFlags.map((f) => `site:${f}`));
  if (input.textSignals.length) reasons.push(...input.textSignals.map((s) => `text:${s}`));
  if (maxScore >= NSFW_IMAGE_THRESHOLD) reasons.push(`image:${maxScore.toFixed(2)}`);
  if (reasons.length) return { rating: 'adult', score: Math.max(maxScore, 1), reasons };

  if (input.imageScores.length > 0) return { rating: 'safe', score: maxScore, reasons: [] };
  if (input.imageFailures > 0) return { rating: 'unknown', score: 0, reasons: ['image-unclassified'] };
  return { rating: 'safe', score: 0, reasons: ['no-artwork'] };
}
