import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { SettingsRepo, defaultSettings } from '../src/main/repos';
import { CustomSounds } from '../src/main/custom-sounds';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cgl-sounds-'));
  const db = openDb(join(dir, 'db.sqlite'));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const settings = new SettingsRepo(db, defaultSettings({ games: join(dir, 'g'), downloads: join(dir, 'd') }));
  const store = join(dir, 'sounds');
  const file = (name: string, bytes = 'ID3 fake audio') => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
  return { settings, store, sounds: new CustomSounds(store, settings), file };
}

describe('custom sounds', () => {
  it('keeps its own copy of the chosen file', () => {
    const { settings, store, sounds, file } = setup();
    const src = file('My Click.mp3');
    const s = sounds.adopt('click', src);
    expect(s.customSounds.click?.name).toBe('My Click.mp3');
    rmSync(src);
    expect(Buffer.from(sounds.read('click')!).toString()).toBe('ID3 fake audio');
    expect(settings.get().customSounds.click?.file).toBe(readdirSync(store)[0]);
  });

  it('replacing or resetting a sound removes the old copy', () => {
    const { settings, store, sounds, file } = setup();
    sounds.adopt('quit', file('a.mp3', 'one'));
    sounds.adopt('quit', file('b.wav', 'two'));
    expect(readdirSync(store)).toHaveLength(1);
    expect(Buffer.from(sounds.read('quit')!).toString()).toBe('two');
    sounds.reset('quit');
    expect(readdirSync(store)).toHaveLength(0);
    expect(settings.get().customSounds.quit).toBeUndefined();
    expect(sounds.read('quit')).toBeNull();
  });

  it('refuses files that are not audio, and empty files', () => {
    const { sounds, file } = setup();
    expect(() => sounds.adopt('hover', file('notes.txt'))).toThrow(/audio file/);
    expect(() => sounds.adopt('hover', file('empty.mp3', ''))).toThrow(/empty/);
  });

  it('settings saved before custom sounds existed have none', () => {
    const { settings } = setup();
    expect(settings.get().customSounds).toEqual({});
  });
});
