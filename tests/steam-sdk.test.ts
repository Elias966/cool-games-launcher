import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSteamSdk, steamRoots } from '../src/main/steam-sdk';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cgl-sdk-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const put = (p: string, body = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

describe('Steam\'s library for Valve Proton\'s Steam bridge', () => {
  it('links ~/.steam/sdk64 and sdk32 to the Flatpak Steam the Proton comes from', () => {
    const home = temp();
    const steam = join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam');
    put(join(steam, 'linux64/steamclient.so'), '64');
    put(join(steam, 'linux32/steamclient.so'), '32');
    const proton = join(steam, 'steamapps/common/Proton - Experimental');
    expect(steamRoots(proton, home)).toEqual([steam]);
    expect(ensureSteamSdk(proton, home)).toBe(true);
    expect(readFileSync(join(home, '.steam/sdk64/steamclient.so'), 'utf8')).toBe('64');
    expect(readFileSync(join(home, '.steam/sdk32/steamclient.so'), 'utf8')).toBe('32');
    expect(lstatSync(join(home, '.steam/sdk64/steamclient.so')).isSymbolicLink()).toBe(true);
  });

  it('leaves a working native Steam setup alone and repairs a dangling link', () => {
    const home = temp();
    put(join(home, '.local/share/Steam/linux64/steamclient.so'), 'native');
    put(join(home, '.steam/sdk64/steamclient.so'), 'mine');
    mkdirSync(join(home, '.steam/sdk32'), { recursive: true });
    symlinkSync(join(home, 'gone/steamclient.so'), join(home, '.steam/sdk32/steamclient.so'));
    put(join(home, '.local/share/Steam/linux32/steamclient.so'), 'native32');
    expect(ensureSteamSdk('/opt/proton', home)).toBe(true);
    expect(readFileSync(join(home, '.steam/sdk64/steamclient.so'), 'utf8')).toBe('mine');
    expect(readlinkSync(join(home, '.steam/sdk32/steamclient.so'))).toBe(join(home, '.local/share/Steam/linux32/steamclient.so'));
  });

  it('says so when no Steam is installed', () => {
    const home = temp();
    expect(ensureSteamSdk('/opt/proton', home)).toBe(false);
    expect(existsSync(join(home, '.steam'))).toBe(false);
  });
});
