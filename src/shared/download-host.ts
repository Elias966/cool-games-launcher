import type { PageExtract } from './page-extract';
import { downloadControls } from './download-evidence';
import { countdownSeconds } from './countdown';

// Match statements about this file, not FAQ questions or a footer's help links.
const MISSING = /^(?:(?:sorry|oops|error)[,:.!\s–—-]*)?(?:(?:404|410)(?=$|[\s:–—|!-])(?:\s*[-:–—|]\s*|\s+)?(?:error\s*)?(?:(?:file|page|content)\s+)?(?:not found|gone)?\b|(?:(?:the |this |your )(?:requested )?|requested )?(?:file|download|link|transfer|content|page)(?: you (?:are looking for|are trying to download|requested))?\s+(?:(?:has been|was|is|has)\s+)?(?:deleted|removed|expired|not found|not available|unavailable|no longer (?:available|exists?|accessible)|does not exist|doesn't exist|could not be found|cannot be found)|(?:the )?(?:file|download|link|transfer)\s+(?:you requested\s+)?(?:could not|couldn't|cannot|can't)\s+(?:be found|be accessed)|(?:we\s+)?(?:could not|couldn't|cannot|can't)\s+find\s+(?:this|the|that|your|requested)\s+(?:file|page)|(?:file|page) not found\b)/i;
const SITE_SECTION = /^\/(?:$|(?:home|index(?:\.html?|\.php)?|about|pricing|plans|blog|news|contact|help|faq|support|privacy|terms|upload|register|login)(?:\/|$))/i;

/** Only used after following a download route away from the game's page. */
export function unavailableHostReason(ex: PageExtract, requestedUrl: string): string | null {
  const prominent = [ex.title, ...(ex.notices ?? [])];
  const notice = prominent.find(text => !/^[^.!]*\?/.test(text)
    && !/^(?:404|file not found)\.(?:zip|7z|rar|exe|appimage)(?:\s|$)/i.test(text.trim())
    && (MISSING.test(text.trim()) || /^(?:not found|link expired)(?:\s*[-|–—:].*)?$/i.test(text.trim())));
  if (notice) return `The host reports that this file is unavailable: ${notice.slice(0, 160)}`;
  // Hosts without semantic headings often use one short sentence in a div.
  // Don't inspect an entire article/FAQ where those words may be incidental.
  const leading = (ex.mainText ?? ex.text).trim().slice(0, 400);
  if (MISSING.test(leading) && !downloadControls(ex).length) return 'The host reports that the requested file was removed, expired or not found.';
  try {
    const current = new URL(ex.url), requested = new URL(requestedUrl);
    if (current.href !== requested.href && SITE_SECTION.test(current.pathname)
      && !current.search && !current.hash && !downloadControls(ex).length && countdownSeconds(ex.text) === null) {
      return 'The file link led to the host homepage or an unrelated site section instead of a file.';
    }
  } catch { /* Invalid routes are handled by the browser. */ }
  return null;
}
