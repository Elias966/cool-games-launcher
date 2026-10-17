import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_HEIGHT, CARD_THUMBNAIL, CARD_WIDTH } from '@shared/artwork';

let runtime: Promise<any> | null = null;
const vips = () => runtime ??= (require('wasm-vips') as (options: object) => Promise<any>)({ dynamicLibraries: [] }).then((v) => { v.concurrency(1); return v; });

export function thumbnailPath(dir: string, file: string): string {
  return join(dir, CARD_THUMBNAIL, `${file}.jpg`);
}

/** Runs off the main/UI threads; shrink-on-load bounds decoder and texture memory. */
export async function makeCardThumbnail(dir: string, file: string): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|custom-[a-f0-9]{20})\.(jpg|png|webp|gif|avif)$/.test(file)) throw new Error('Invalid artwork file');
  const dest = thumbnailPath(dir, file);
  if (existsSync(dest)) return dest;
  const v = await vips();
  const image = v.Image.thumbnailBuffer(readFileSync(join(dir, file)), CARD_WIDTH, { height: CARD_HEIGHT, size: 'down' });
  let flat;
  try {
    flat = image.hasAlpha() ? image.flatten({ background: [8, 12, 20] }) : null;
    const data = (flat ?? image).writeToBuffer('.jpg', { Q: 82, strip: true });
    mkdirSync(join(dir, CARD_THUMBNAIL), { recursive: true });
    const temp = `${dest}.${process.pid}.tmp`;
    writeFileSync(temp, data);
    renameSync(temp, dest);
    return dest;
  } finally { flat?.delete(); image.delete(); }
}
