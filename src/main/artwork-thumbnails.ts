import { existsSync } from 'node:fs';
import type { WorkerHost } from './worker-host';
import { thumbnailPath } from '../workers/artwork-thumbnail';

export class ArtworkThumbnails {
  private pending = new Map<string, Promise<string>>();
  constructor(private dir: string, private worker: Pick<WorkerHost, 'call'>) {}

  get(file: string): Promise<string> {
    const path = thumbnailPath(this.dir, file);
    if (existsSync(path)) return Promise.resolve(path);
    let pending = this.pending.get(file);
    if (!pending) {
      pending = this.worker.call<string>('thumbnail', { dir: this.dir, file }).finally(() => this.pending.delete(file));
      this.pending.set(file, pending);
    }
    return pending;
  }
}
