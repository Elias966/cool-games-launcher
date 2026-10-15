// GE-Proton is provisioned through the same resumable queue as game downloads.
// Only a verified archive is extracted, into a staging directory first.
import { existsSync, statSync, mkdirSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WorkerHost } from './worker-host';
import type { DownloadsRepo, SettingsRepo } from './repos';
import type { DownloadManager } from './downloads';
import type { ProtonPackage } from '@shared/types';
import { publish, toast } from './bus';
import { tm } from './i18n';

export interface ProtonPin { version: string; url: string; sha256: string; size: number; dir: string }
export interface CompatStatus { protonPath: string | null; provisioning: boolean; python3: boolean }

export class CompatManager {
  private installing: number | null = null;
  private waiting: Array<() => void> = [];
  private runtimeNoticeShown = false;
  private python3: boolean;

  constructor(private deps: {
    settings: SettingsRepo;
    repo: DownloadsRepo;
    downloads: DownloadManager;
    worker: WorkerHost;
    dataDir: string;
    pin: ProtonPin;
    detectProton: () => string[];
    pythonAvailable?: () => boolean;
  }) {
    this.python3 = deps.pythonAvailable ? deps.pythonAvailable() : this.detectPython();
    deps.downloads.on('completed', (id: number, path: string) => {
      if (this.isOwnDownload(id)) void this.installArchive(id, path);
    });
  }

  private detectPython(): boolean {
    try { execFileSync('python3', ['--version'], { stdio: 'ignore', timeout: 2000 }); return true; } catch { return false; }
  }

  private valid(dir: string): boolean {
    try { return statSync(join(dir, 'proton')).isFile(); } catch { return false; }
  }

  protonPath(): string | null {
    const configured = this.deps.settings.get().protonPath;
    if (configured && this.valid(configured)) return configured;
    const detected = this.deps.detectProton().find((p) => this.valid(p));
    if (detected) return detected;
    const provisioned = join(this.deps.dataDir, 'compat', this.deps.pin.dir);
    return this.valid(provisioned) ? provisioned : null;
  }

  status(): CompatStatus {
    const transfer = this.deps.repo.list().find((d) => this.isOwnDownload(d.id) && ['queued', 'active', 'paused'].includes(d.state));
    return { protonPath: this.protonPath(), provisioning: this.installing !== null || !!transfer, python3: this.python3 };
  }

  private isOwnDownload(id: number): boolean {
    const d = this.deps.repo.get(id);
    return !!d && d.catalogId === null && (!!d.compatPackage || d.url === this.deps.pin.url);
  }

  /** Starts or resumes setup. No game is launched automatically after setup. */
  async installProton(): Promise<CompatStatus> {
    if (!this.python3) throw new Error('Python 3 is required by umu-launcher. Install python3 using your distribution package manager, then restart the launcher.');
    if (this.protonPath() || this.installing !== null) return this.status();
    return this.installPackage({ ...this.deps.pin, provider: 'ge' });
  }

  installed(): Array<{ path: string; name: string }> {
    const root = join(this.deps.dataDir, 'compat');
    const managed = existsSync(root) ? readdirSync(root).filter((n) => !n.startsWith('.')).map((n) => join(root, n)) : [];
    return [...new Set([...this.deps.detectProton(), ...managed, this.deps.settings.get().protonPath])]
      .filter((p) => p && this.valid(p)).map((p) => ({ path: p, name: p.split('/').pop()! }));
  }

  async installPackage(pin: ProtonPackage): Promise<CompatStatus> {
    if (!this.python3) throw new Error('Install Python 3 and restart the launcher before installing Proton.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/.test(pin.dir) || !/^[a-f0-9]{64}$/i.test(pin.sha256)) throw new Error('Invalid Proton package metadata');
    const destination = join(this.deps.dataDir, 'compat', pin.dir);
    if (this.valid(destination)) {
      this.deps.settings.update({ protonPath: destination });
      publish('settings:changed', this.deps.settings.get());
      return this.status();
    }
    const other = this.deps.repo.list().find((d) => this.isOwnDownload(d.id) && ['active', 'queued', 'paused'].includes(d.state) && d.url !== pin.url);
    if (other || this.installing !== null) throw new Error('Finish or cancel the current Proton setup in Downloads before installing another version.');
    const existing = this.deps.repo.list().find((d) => this.isOwnDownload(d.id) && d.url === pin.url);
    if (existing?.state === 'completed' && existing.finalPath && existsSync(existing.finalPath) && existing.installState !== 'failed') {
      void this.installArchive(existing.id, existing.finalPath);
    } else if (existing && ['active', 'queued', 'paused'].includes(existing.state)) {
      if (existing.state === 'paused') this.deps.downloads.resume(existing.id);
    } else {
      const d = existing ?? this.deps.repo.create({ catalogId: null, title: `${pin.version} (Windows compatibility)`, sourceHost: 'github.com', state: 'queued' });
      this.deps.repo.update(d.id, { compatPackage: pin, installState: 'none', installDetail: null, receivedBytes: 0, retries: 0 });
      this.deps.downloads.handoff(d.id, pin.url, {}, pin.url.split('/').pop() ?? `${pin.dir}.tar.gz`, pin.size);
      toast('info', tm('Downloading {name}. Progress is available in Downloads.', { name: pin.version }));
    }
    return this.status();
  }

  async ensureProton(): Promise<string> {
    if (!this.python3) throw new Error('Proton needs Python 3. Install python3 using your distribution package manager, then restart the launcher.');
    const ready = this.protonPath();
    if (ready) return ready;
    await this.installProton();
    throw Object.assign(new Error('Preparing Proton…'), { code: 'proton-provisioning' });
  }

  /** Runs once the managed Proton finishes installing (e.g. a Play press made meanwhile). */
  whenReady(run: () => void) {
    if (this.protonPath()) run();
    else this.waiting.push(run);
  }

  recover() {
    for (const d of this.deps.repo.byState('completed')) {
      if (this.isOwnDownload(d.id) && d.finalPath && existsSync(d.finalPath) && ['none', 'installing'].includes(d.installState) ) {
        void this.installArchive(d.id, d.finalPath);
        break;
      }
    }
  }

  notifyRuntime() {
    if (this.runtimeNoticeShown) return;
    this.runtimeNoticeShown = true;
    toast('info', tm('First Proton launch downloads the Steam Linux Runtime; this can take a few minutes.'));
  }

  private async installArchive(id: number, archive: string) {
    if (this.installing !== null) return;
    this.installing = id;
    const pin = this.deps.repo.get(id)?.compatPackage ?? this.deps.pin;
    const root = join(this.deps.dataDir, 'compat');
    const staging = join(root, `.staging-${id}`);
    const update = (installDetail: string) => {
      this.deps.repo.update(id, { installState: 'installing', installDetail });
      this.deps.downloads.broadcastList();
    };
    try {
      update(`Verifying ${pin.version} SHA-256…`);
      const hash = await this.deps.worker.call<string>('hashFile', { path: archive });
      if (hash !== pin.sha256) throw new Error('Proton checksum mismatch. Use Install selected version in Settings to download a fresh copy.');
      mkdirSync(root, { recursive: true });
      rmSync(staging, { recursive: true, force: true });
      update(`Extracting verified ${pin.version}…`);
      await this.deps.worker.call('extractCompat', { path: archive, dest: staging });
      const candidates = [staging, ...readdirSync(staging).map((n) => join(staging, n))].filter((p) => this.valid(p));
      if (candidates.length !== 1) throw new Error('The Proton archive does not contain exactly one expected launcher.');
      const unpacked = candidates[0];
      const dest = join(root, pin.dir);
      rmSync(dest, { recursive: true, force: true });
      renameSync(unpacked, dest);
      this.deps.settings.update({ protonPath: dest });
      publish('settings:changed', this.deps.settings.get());
      this.deps.repo.update(id, { installState: 'installed', installDetail: `${pin.version} is ready. Press Play in the Library.` });
      toast('success', tm('Proton is ready. Windows games can now use the Proton runner.'));
      for (const run of this.waiting.splice(0)) run();
    } catch (e) {
      this.deps.repo.update(id, { installState: 'failed', installDetail: (e as Error).message });
      toast('error', tm('Proton setup failed: {detail}', { detail: (e as Error).message }));
    } finally {
      try { rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a retry removes interrupted staging before extraction */ }
      this.installing = null;
      this.deps.downloads.broadcastList();
    }
  }
}
