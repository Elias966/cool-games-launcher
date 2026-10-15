// Message envelope between the main process and utility-process workers.

export interface WorkerRequest {
  kind: 'req';
  id: number;
  method: string;
  params: unknown;
}

export interface WorkerCancel {
  kind: 'cancel';
  id: number;
}

export interface WorkerResponse {
  kind: 'res';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { message: string; code?: string };
}

export interface WorkerEvent {
  kind: 'event';
  event: string;
  data: unknown;
}

export type ToWorker = WorkerRequest | WorkerCancel;
export type FromWorker = WorkerResponse | WorkerEvent;

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

export class CancelledError extends Error {
  readonly code = 'cancelled';
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancelled(err: unknown): boolean {
  return (
    err instanceof CancelledError ||
    (typeof err === 'object' && err !== null && ((err as { code?: string }).code === 'cancelled' || (err as Error).name === 'AbortError'))
  );
}
