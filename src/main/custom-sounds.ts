// The user's own audio files for interface sounds. Each chosen file is copied
// into the launcher's data folder, so moving or deleting the original does not
// break it; the renderer reads the copy back over IPC and decodes it itself.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { CustomSound, Settings } from '@shared/types';
import type { SettingsRepo } from './repos';

/** Formats Chromium decodes. */
export const SOUND_EXTENSIONS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'webm'];

export class CustomSounds {
  constructor(private readonly dir: string, private readonly settings: SettingsRepo) {}

  /** Uses `source` for `sound`, replacing any earlier file. */
  adopt(sound: CustomSound, source: string): Settings {
    const ext = extname(source).slice(1).toLowerCase();
    if (!SOUND_EXTENSIONS.includes(ext)) throw new Error('Choose an audio file (MP3, OGG, WAV, FLAC or M4A).');
    const st = statSync(source);
    if (!st.isFile() || st.size === 0) throw new Error('That file is empty.');
    mkdirSync(this.dir, { recursive: true });
    const file = `${sound}-${Date.now()}.${ext}`;
    copyFileSync(source, join(this.dir, file));
    const previous = this.settings.get().customSounds[sound];
    const s = this.settings.update({ customSounds: { ...this.settings.get().customSounds, [sound]: { file, name: basename(source) } } });
    if (previous) this.remove(previous.file);
    return s;
  }

  /** Back to the built-in sound. */
  reset(sound: CustomSound): Settings {
    const all = { ...this.settings.get().customSounds };
    const previous = all[sound];
    delete all[sound];
    const s = this.settings.update({ customSounds: all });
    if (previous) this.remove(previous.file);
    return s;
  }

  read(sound: CustomSound): Uint8Array | null {
    const entry = this.settings.get().customSounds[sound];
    if (!entry) return null;
    const path = join(this.dir, basename(entry.file));
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  private remove(file: string) {
    rmSync(join(this.dir, basename(file)), { force: true });
  }
}
