import { serve } from './rpc';
import { makeCardThumbnail } from './artwork-thumbnail';

process.title = 'cgl-artwork';
let queue: Promise<unknown> = Promise.resolve();
serve({
  thumbnail({ dir, file }: { dir: string; file: string }) {
    const result = queue.then(() => makeCardThumbnail(dir, file));
    queue = result.catch(() => undefined);
    return result;
  },
});
