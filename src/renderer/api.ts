import type { CglApi } from '@shared/ipc';

declare global {
  interface Window {
    cgl: CglApi;
  }
}

export const api: CglApi = window.cgl;
