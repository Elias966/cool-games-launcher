import {MODEL_CATALOG,DEFAULT_MODEL_ID} from '@shared/models';
// Standard Linux user directories (XDG Base Directory spec) and bundled-vendor lookup.
import { app } from 'electron';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const APP_ID = 'cool-games-launcher';

function xdg(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && v.startsWith('/') ? v : join(homedir(), fallback);
}

export const paths = (() => {
  const config = join(xdg('XDG_CONFIG_HOME', '.config'), APP_ID);
  const data = join(xdg('XDG_DATA_HOME', '.local/share'), APP_ID);
  const cache = join(xdg('XDG_CACHE_HOME', '.cache'), APP_ID);
  const runtimeBase = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : tmpdir();
  return {
    config,
    data,
    cache,
    db: join(data, 'launcher.db'),
    games: join(data, 'games'),
    models: join(data, 'models'),
    prefixes: join(data, 'prefixes'),
    /** Pristine file lists of prepared game builds, to tell saves apart on update. */
    manifests: join(data, 'manifests'),
    /** Per-game save backups, as plain folders. */
    saveBackups: join(data, 'save-backups'),
    downloads: join(data, 'downloads'),
    logs: join(data, 'logs'),
    browserProfile: join(data, 'browser-profile'),
    browserStaging: join(cache, 'browser-downloads'),
    artwork: join(cache, 'artwork'),
    runtime: join(runtimeBase, `cgl-${process.getuid?.() ?? 0}`),
  };
})();

export function ensureDirs() {
  for (const d of [paths.config, paths.data, paths.models, paths.cache, paths.games, paths.prefixes, paths.downloads, paths.logs, paths.artwork, paths.browserStaging]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
}

/** Where bundled third-party components live: resources/vendor when packaged, ./vendor in development. */
export function vendorDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'vendor') : join(app.getAppPath(), 'vendor');
}

export function vendor() {
  const v = vendorDir();
  return {
    root: v,
    firefox: join(v, 'firefox', 'firefox'),
    geckodriver: join(v, 'geckodriver', 'geckodriver'),
    ublock: join(v, 'extensions', 'uBlock0@raymondhill.net.xpi'),
    llamaDir: join(v, 'llama'),
    classifier: join(v, 'models', 'nsfw-vit-fp16.onnx'),
    umu: join(v, 'umu', 'umu-run'),
    archiveDecoder: join(v, '7zip', '7zzs'),
    legendary: join(v, 'stores', 'legendary'),
    gogdl: join(v, 'stores', 'gogdl'),
  };
}

export function vendorStatus(): Record<string, boolean> {
  const v = vendor();
  return {
    firefox: existsSync(v.firefox),
    geckodriver: existsSync(v.geckodriver),
    ublock: existsSync(v.ublock),
    llama: existsSync(join(v.llamaDir, 'cpu', 'llama-server')),
    classifier: existsSync(v.classifier),
    umu: existsSync(v.umu),
    archiveDecoder: existsSync(v.archiveDecoder),
  };
}

export function workerPath(name: 'inference' | 'browser' | 'downloads' | 'install' | 'fetcher'): string {
  return join(__dirname, '..', 'workers', `${name}.js`);
}

export function modelPaths(id=DEFAULT_MODEL_ID) {
  if(!MODEL_CATALOG.some(p=>p.id===id))throw Error('Unknown local model');
  return {model:join(paths.models,id,'model.gguf'),vision:join(paths.models,id,'vision.gguf')};
}
