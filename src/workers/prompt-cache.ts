// llama-server reuses the cached prompt for the longest matching token prefix.
// Every image becomes the same placeholder tokens whatever it shows, so a new
// request whose first difference from the cached prompt is a different image
// would be answered with the cached (previous) image's embeddings. Such a
// request is sent without the prompt cache; every other request keeps it.
import { createHash } from 'node:crypto';

type Part = { type: string; text?: string; image_url?: { url: string } };
type Message = { role: string; content: string | Part[] | null };

/** The prompt as a sequence of comparable pieces: roles, texts, and images by content hash. */
export function promptPieces(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    out.push(`R:${m.role}`);
    if (typeof m.content === 'string' || m.content === null) { out.push(`T:${m.content ?? ''}`); continue; }
    for (const p of m.content) {
      if (p.type === 'image_url' && p.image_url) out.push(`I:${createHash('sha1').update(p.image_url.url).digest('hex')}`);
      else out.push(`T:${p.text ?? ''}`);
    }
  }
  return out;
}

/** True when the cached prompt would be wrongly reused up to a different image. */
export function imageWouldBeStale(cached: string[] | null, next: string[]): boolean {
  if (!cached) return false;
  let i = 0;
  while (i < cached.length && i < next.length && cached[i] === next[i]) i++;
  return i < cached.length && i < next.length && cached[i].startsWith('I:') && next[i].startsWith('I:');
}
