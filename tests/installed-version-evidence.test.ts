import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectedInstalledVersion } from '../src/main/installed-version';
import type { GameRecord, DownloadRecord } from '../src/main/repos';
import type { VersionEvidenceResult } from '../src/workers/version-evidence';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'cgl-version-')); dirs.push(dir);
 const executable = join(dir, 'game.exe'); writeFileSync(executable, 'program');
 const game = { id: 7, managed: true, executable, installDir: dir, sourceHost: 'steamrip.com', addedAt: new Date().toISOString(), installedVersion: null } as GameRecord;
 const result: VersionEvidenceResult = { evidence: [], inspectedPaths: [], rejectedResources: [], candidateSnippets: [], limitsReached: false, limitations: [] };
 const evidence = (version: string, scheme: 'semantic'|'developer-build'|'steam-build', path='game-config') => ({id: path+version, version, scheme, path, kind:'game-config' as const, context:'Game metadata'});
 return { game, result, evidence };
}
describe('installed evidence aggregation', () => {
 it('retains separate semantic and developer identifiers without equating either with a Steam build', () => {
  const {game,result,evidence}=fixture(); result.evidence=[evidence('0.1.4.0.848','semantic'),evidence('848','developer-build')];
  expect(inspectedInstalledVersion(game,null,result)).toMatchObject({version:'0.1.4.0.848',scheme:'semantic',identifiers:[{scheme:'semantic',version:'0.1.4.0.848'},{scheme:'developer-build',version:'build 848'}],inspection:{state:'identified'}});
 });
 it('does not choose the first of conflicting local versions', () => {
  const {game,result,evidence}=fixture(); result.evidence=[evidence('2.0','semantic','exe'),evidence('3.0','semantic','config')];
  expect(inspectedInstalledVersion(game,null,result)).toMatchObject({version:null,inspection:{state:'unresolved'}});
 });
 it('rejects a cached receipt after the installed executable changes', () => {
  const {game,result}=fixture();
  const d={gameId:7,state:'completed',installState:'installed',preparation:{installDir:game.installDir},resolution:{buildVersion:{version:'build 1234',scheme:'steam-build',files:[],sizes:[],updated:null,at:game.addedAt}},url:'https://host/game.zip',fileName:'game.zip'} as unknown as DownloadRecord;
  result.inspectedPaths=[game.executable!];
  game.installedVersion=inspectedInstalledVersion(game,d,result,true);
  expect(game.installedVersion.version).toBe('build 1234');
  writeFileSync(game.executable!,'different game program');
  expect(inspectedInstalledVersion(game,d,result).version).toBeNull();
 });
 it('does not trust a current catalog title or an arbitrary old imported fingerprint', () => {
  const {game,result}=fixture(); game.installedVersion={version:'999.0',updated:null,files:[],sizes:[],at:game.addedAt};
  expect(inspectedInstalledVersion(game,null,result)).toMatchObject({version:null,inspection:{state:'unresolved'}});
 });
});
