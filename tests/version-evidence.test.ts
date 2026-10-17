import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { discoverVersionEvidence } from '../src/workers/version-evidence';
import { readPeVersion } from '../src/main/pe-version';
import { readUnrealVersion } from '../src/workers/unreal-version';

vi.mock('../src/main/pe-version', () => ({ readPeVersion: vi.fn() }));
vi.mock('../src/workers/unreal-version', () => ({ readUnrealVersion: vi.fn() }));
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cgl-version-evidence-')); vi.mocked(readPeVersion).mockReset().mockReturnValue(null); vi.mocked(readUnrealVersion).mockReset().mockResolvedValue({ evidence: [], limitations: [] }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(path: string, body: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; }
function scan(dir = root, title = 'Orbit', executable = 'Orbit.exe') { return discoverVersionEvidence({ installDir: dir, title, executable }); }

describe('bounded installed game version discovery', async () => {
  it('rejects bootstrap engine metadata and inspects the actual shipping executable', async () => {
    put(join(root, 'Orbit.exe'), 'bootstrap'); put(join(root, 'Orbit/Binaries/Win64/Orbit-Win64-Shipping.exe'), 'game');
    put(join(root, 'Engine/Binaries/Win64/CrashReportClient.exe'), 'helper');
    put(join(root, 'SomeBundledTool.exe'), 'unrelated');
    vi.mocked(readPeVersion).mockImplementation(path => ({ resources: [], gameVersion: basename(path).startsWith('Orbit-Win64') ? '2.7.4' : null, rejectionReason: basename(path) === 'Orbit.exe' ? 'Executable reports engine metadata, not the game version' : null }));
    const result = await scan();
    expect(result.evidence.map(e => [e.version, e.kind])).toEqual([['2.7.4', 'exe']]);
    expect(result.rejectedResources[0].reason).toContain('engine');
    expect(vi.mocked(readPeVersion).mock.calls.some(([p]) => p.includes('/Engine/') || p.includes('SomeBundledTool'))).toBe(false);
  });
  it('finds explicit game config fields, rejects engine sections and boilerplate', async () => {
    put(join(root, 'Orbit/Config/DefaultGame.ini'), '[/Script/EngineSettings.GeneralProjectSettings]\nProjectVersion=0.9.7\n[Engine]\nBuildVersion=40574608\n');
    put(join(root, 'version.txt'), '1.0.0.0');
    put(join(root, 'Orbit/Binaries/Win64/OnlineFix.ini'), '[Main]\nBuildId=0\n');
    put(join(root, 'node_modules/some-game/version.txt'), '9.8.7');
    const result = await scan();
    expect(result.evidence.map(e => e.version)).toEqual(['0.9.7']);
    expect(result.rejectedResources.some(e => e.reason.includes('engine/runtime'))).toBe(true);
    expect(result.evidence.some(e => e.version === '0')).toBe(false);
  });
  it('retains developer and Steam build namespaces without pretending they are comparable', async () => {
    const dir = join(root, 'steamapps/common/Orbit');
    put(join(dir, 'steam_appid.txt'), '1234'); put(join(dir, 'Config/BuildSettings.ini'), '[GeneralSettings]\nBuildVersion=848\n');
    put(join(root, 'steamapps/appmanifest_1234.acf'), '"AppState" { "appid" "1234" "buildid" "25505592" }');
    put(join(root, 'steamapps/appmanifest_999.acf'), '"AppState" { "appid" "999" "buildid" "99999999" }');
    expect((await scan(dir)).evidence.map(e => [e.version, e.scheme])).toEqual([['848', 'developer-build'], ['25505592', 'steam-build']]);
  });
  it('can identify the Steam app from RealAppId and rejects a mismatched manifest payload', async () => {
    const dir = join(root, 'steamapps/common/Orbit');
    put(join(dir, 'Binaries/Win64/OnlineFix.ini'), 'RealAppId=1234\nBuildId=0\n');
    put(join(root, 'steamapps/appmanifest_1234.acf'), '"appid" "999" "buildid" "25505592"');
    const result = await scan(dir);
    expect(result.evidence).toEqual([]);
    expect(result.rejectedResources.some(r => r.reason.includes('identity'))).toBe(true);
  });
  it('only trusts GOG and Epic metadata that identify this installed game', async () => {
    put(join(root, 'goggame-123.info'), JSON.stringify({ name: 'Orbit', buildId: '12345' }));
    put(join(root, 'goggame-999.info'), JSON.stringify({ name: 'Other game', buildId: '98765' }));
    put(join(root, 'Orbit.item'), JSON.stringify({ DisplayName: 'Orbit', InstallLocation: root, AppVersionString: 'EGS_1.08.4' }));
    put(join(root, 'Other.item'), JSON.stringify({ DisplayName: 'Other game', InstallLocation: root, AppVersionString: '9.8.7' }));
    expect((await scan()).evidence.map(e => [e.version, e.scheme])).toEqual([['12345', 'gog-build'], ['EGS_1.08.4', 'epic-build']]);
  });
  it('scans only this game in the provided prefix, preserving version log context', async () => {
    const prefixDir = join(root, 'prefix'), dir = join(root, 'install'); mkdirSync(dir);
    const log = put(join(prefixDir, 'drive_c/users/steamuser/AppData/Local/Orbit/Saved/Logs/Orbit.log'), '[2026.01] LogGame: GameVersion: 2.3.4\nLogInit: EngineVersion: 5.5.4\n');
    put(join(prefixDir, 'drive_c/users/steamuser/AppData/Local/Unrelated/Saved/Logs/Game.log'), 'GameVersion=99.99');
    const result = await discoverVersionEvidence({ installDir: dir, executable: 'Orbit.exe', title: 'Orbit', prefixDir });
    expect(result.evidence.map(e => [e.path, e.version, e.kind])).toEqual([[log, '2.3.4', 'game-log']]);
    expect(result.candidateSnippets[0].text).toContain('2.3.4');
    expect(result.inspectedPaths.some(p => p.includes('Unrelated'))).toBe(false);
  });
  it('does not follow symlinks or read huge candidate text files', async () => {
    put(join(root, 'outside/version.txt'), '9.9.9'); const dir = join(root, 'game'); mkdirSync(dir);
    symlinkSync(join(root, 'outside'), join(dir, 'Config')); put(join(dir, 'build.json'), ' '.repeat(300 * 1024));
    const result = await scan(dir);
    expect(result.evidence).toEqual([]); expect(result.limitsReached).toBe(true);
    expect(result.inspectedPaths.some(p => p.includes('outside'))).toBe(false);
  });
  it('does not use timestamps, unrelated JSON dependency versions or placeholder build ids', async () => {
    put(join(root, 'package.json'), '{"version":"999.9.9"}'); put(join(root, 'Config/BuildSettings.ini'), 'BuildId=0\n');
    put(join(root, 'Manifest_NonUFSFiles_Win64.txt'), 'Orbit.exe\t2025-12-11T00:30:47.744Z');
    expect((await scan()).evidence).toEqual([]);
  });
  it('combines verified pak configuration from the actual shipping EXE with distinct build namespaces', async () => {
    put(join(root, 'Orbit.exe'), 'bootstrap');
    const shipping = put(join(root, 'Orbit/Binaries/Win64/Orbit-Win64-Shipping.exe'), 'game');
    const pak = put(join(root, 'Orbit/Content/Paks/pakchunk0-Windows.pak'), 'bounded fixture parsed by container reader');
    vi.mocked(readUnrealVersion).mockResolvedValue({ evidence: [
      { version: '241', namespace: 'developer-build', source: `${pak}::Orbit/Config/BuildSettings.ini`, verified: true },
      { version: '0.7.0.0.241', namespace: 'semantic', source: `${pak}::Orbit/Config/DefaultGame.ini`, verified: true },
    ], limitations: [] });
    const result = await scan();
    expect(readUnrealVersion).toHaveBeenCalledExactlyOnceWith({ executable: shipping, pakFiles: [pak] });
    expect(result.evidence.map(e => [e.version, e.scheme, e.kind])).toEqual([
      ['241', 'developer-build', 'game-config'], ['0.7.0.0.241', 'semantic', 'game-config'],
    ]);
    expect(new Set(result.evidence.map(e => e.id)).size).toBe(2);
    expect(result.inspectedPaths).toContain(pak);
  });
  it('caps executable discovery even if the imported folder has many EXEs', async () => {
    for (let i = 0; i < 50; i++) put(join(root, `Game${i}-Win64-Shipping.exe`), 'no PE');
    const result = await scan();
    expect(vi.mocked(readPeVersion).mock.calls.length).toBe(30); expect(result.limitsReached).toBe(true);
  });
});
