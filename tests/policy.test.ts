import { describe, expect, it } from 'vitest';
import { combineClassification, isCurrent, isVisible, textAdultSignals, visibleRatings, NSFW_IMAGE_THRESHOLD } from '@shared/policy';

describe('visibility', () => {
  it('hides adult and unknown content by default', () => {
    const off = { showNsfw: false };
    expect(isVisible('safe', off)).toBe(true);
    expect(isVisible('adult', off)).toBe(false);
    expect(isVisible('unknown', off)).toBe(false);
  });

  it('never shows unclassified content, even with NSFW enabled', () => {
    const on = { showNsfw: true };
    expect(isVisible('adult', on)).toBe(true);
    expect(isVisible('unknown', on)).toBe(false);
    expect(visibleRatings(on)).toEqual(['safe', 'adult']);
  });

  it('rejects results produced under an older policy revision', () => {
    expect(isCurrent(3, { showNsfw: false, revision: 3 })).toBe(true);
    expect(isCurrent(2, { showNsfw: false, revision: 3 })).toBe(false);
  });
});

describe('classification', () => {
  it('rates an entry adult when any image crosses the threshold', () => {
    const r = combineClassification({ imageScores: [0.1, NSFW_IMAGE_THRESHOLD + 0.01], imageFailures: 0, textSignals: [], siteFlags: [] });
    expect(r.rating).toBe('adult');
  });

  it('lets text evidence win over clean artwork', () => {
    const r = combineClassification({ imageScores: [0.02], imageFailures: 0, textSignals: ['hentai'], siteFlags: [] });
    expect(r.rating).toBe('adult');
    expect(r.reasons).toContain('text:hentai');
  });

  it('honours site-provided adult labels', () => {
    expect(combineClassification({ imageScores: [0.01], imageFailures: 0, textSignals: [], siteFlags: ['rta-label'] }).rating).toBe('adult');
  });

  it('keeps entries unknown when their artwork could not be classified', () => {
    expect(combineClassification({ imageScores: [], imageFailures: 1, textSignals: [], siteFlags: [] }).rating).toBe('unknown');
  });

  it('rates entries without any artwork by their text alone', () => {
    expect(combineClassification({ imageScores: [], imageFailures: 0, textSignals: [], siteFlags: [] }).rating).toBe('safe');
  });

  it('finds adult signals in free text without flagging ordinary words', () => {
    expect(textAdultSignals('A cozy farming sim', 'Plant crops and make friends')).toEqual([]);
    expect(textAdultSignals('Adults only visual novel')).toContain('adults only');
    expect(textAdultSignals('NSFW content warning')).toContain('nsfw');
    expect(textAdultSignals('Recommended for 18+ players')).toContain('18+');
    expect(textAdultSignals('Toddlers aged 18+ months')).toEqual([]);
    expect(textAdultSignals('Essex road trip')).toEqual([]);
  });
});
