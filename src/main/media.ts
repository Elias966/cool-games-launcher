// cgl-media:// serves cached artwork and approved browser snapshots to the
// renderer. Visibility is enforced here, in the main process: adult or
// unclassified artwork is refused unless the current policy allows it.
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { CatalogRepo } from './repos';
import type { PolicyService } from './policy-service';
import type { BrowserView } from './browser-view';

export const MEDIA_SCHEME = 'cgl-media';

export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: false } }]);
}

const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

export function handleMedia(deps: { artworkDir: string; catalog: CatalogRepo; policy: PolicyService; browserView: BrowserView }) {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const url = new URL(req.url);
    if (process.env.CGL_DEBUG) console.log('[media]', req.url, url.hostname, url.pathname);
    const deny = (status = 404) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
    if (url.hostname === 'artwork') {
      const file = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (!/^[a-f0-9]{40}\.(jpg|png|webp|gif|avif)$/.test(file)) return deny(400);
      if (!deps.catalog.artworkVisible(file, deps.policy.policy())) return deny(403);
      const full = resolve(join(deps.artworkDir, file));
      if (!full.startsWith(resolve(deps.artworkDir) + sep)) return deny(400);
      try {
        const buf = await readFile(full);
        return new Response(new Uint8Array(buf), { headers: { 'Content-Type': TYPES[file.split('.').pop()!] ?? 'application/octet-stream', 'Cache-Control': 'no-store' } });
      } catch {
        return deny();
      }
    }
    if (url.hostname === 'snapshot') {
      const seq = Number(url.pathname.replace(/^\//, ''));
      const png = Number.isInteger(seq) ? deps.browserView.currentFrame(seq) : null;
      if (!png) return deny(410);
      return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
    }
    return deny();
  });
}
