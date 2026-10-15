// Deterministic model decisions for lifecycle/queue tests only. Real model
// capability is measured separately by the browser-agent integration suite.
import { vi } from 'vitest';
import type { PageExtract } from '../../src/shared/page-extract';
import { downloadEvidence } from '../../src/shared/download-evidence';
import type { LocalGameAgent } from '../../src/main/game-agent';
export function fixtureAgent() {
  return {
    verify: vi.fn(async (ex: PageExtract) => ex),
    listing: vi.fn(async (ex: PageExtract) => ({ cards: ex.cards, routes: [...(ex.nextPage ? [ex.nextPage] : []), ...ex.links.filter(l => l.href.includes('/category/')).map(l => l.href)], gameTitle: ex.game && downloadEvidence(ex).length ? ex.game.title : null, step: {kind:'done',index:null} })),
    learnListing: vi.fn(async (ex: PageExtract) => ({
      games: ex.cards.map(c => c.href),
      more: [...(ex.nextPage ? [ex.nextPage] : []), ...ex.links.filter(l => l.href.includes('/category/')).map(l => l.href)],
      pageIsGame: !ex.cards.length && !!ex.game && downloadEvidence(ex).length > 0,
    })),
    // Structure decides every fixture page; an ambiguous page is treated as not a game.
    confirmGame: vi.fn(async () => null),
    game: vi.fn(async (ex: PageExtract) => ({ game: ex.game, candidates: downloadEvidence(ex), step:{kind:'done',index:null} })),
  } as unknown as LocalGameAgent;
}
