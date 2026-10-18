import {existsSync,readFileSync,mkdirSync,copyFileSync,writeFileSync,lstatSync,chmodSync,readlinkSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {NormalFirefox} from './normal-firefox';

const BEGIN='// Cool Games Launcher private Firefox connection';
const END='// End Cool Games Launcher private Firefox connection';
export function connectionPreferences(original:string){
  const start=original.indexOf(BEGIN),end=original.indexOf(END,start);
  const base=start>=0&&end>=0?original.slice(0,start)+original.slice(end+END.length):original;
  return base.trimEnd()+'\n'+BEGIN+'\n'+[
    ['devtools.chrome.enabled',true],['devtools.debugger.remote-enabled',true],
    ['devtools.debugger.force-local',true],['devtools.debugger.prompt-connection',false],
  ].map(([key,value])=>`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n')+'\n'+END+'\n';
}

/** No personal profiles.ini, cookies, preferences or tabs are read. Snap can
 * access only its own common directory, so keep its isolated profile there. */
export function installedFirefoxProfile(home=homedir(),snap=existsSync('/snap/bin/firefox')){
  return snap?join(home,'snap/firefox/common/cool-games-launcher-browser'):join(process.env.XDG_DATA_HOME||join(home,'.local/share'),'cool-games-launcher/installed-firefox-profile');
}
export function installedFirefoxBinary(){
  for(const binary of ['/snap/bin/firefox','/usr/bin/firefox','/usr/bin/firefox-esr'])if(existsSync(binary))return binary;
  throw Error('No installed Firefox was found. Install Firefox or select a bundled browser mode.');
}
function profileIsOpen(profile:string){
  try{const lock=readlinkSync(join(profile,'lock'));const pid=Number(lock.match(/\+?(\d+)$/)?.[1]);if(!pid)return true;return existsSync('/proc/'+pid)}catch{return false}
}

/** Linux limits the address passed to bind/connect, not the resolved file
 * location. These proc paths refer to the same private directory without
 * moving the profile, exposing a TCP port or relying on Snap's private /tmp. */
export function privateFirefoxSocket(bridgeDir: string) {
  const file = join(bridgeDir, 'control.sock');
  if (Buffer.byteLength(file) <= 103) return { file, connectPath: file, listenPath: file, cwd: undefined, close: () => undefined };
  const fd = openSync(bridgeDir, 'r');
  let closed = false;
  return {
    file, connectPath: `/proc/self/fd/${fd}/control.sock`,
    listenPath: '/proc/self/cwd/control.sock', cwd: bridgeDir,
    close: () => { if (!closed) { closed = true; closeSync(fd); } },
  };
}

export async function connectInstalledFirefox(config:{bridgeDir:string;profileDir:string;binary?:string}){
  const binary=config.binary??installedFirefoxBinary(),profile=config.profileDir;
  const bridgeDir=join(profile,'chrome/cgl-launcher');mkdirSync(join(bridgeDir,'cgl-browser'),{recursive:true,mode:0o700});chmodSync(bridgeDir,0o700);
  for(const relative of ['cgl-browser.cfg','cgl-browser/CglBrowserChild.sys.mjs'])copyFileSync(join(config.bridgeDir,relative),join(bridgeDir,relative));
  const userFile=join(profile,'user.js'),original=existsSync(userFile)?readFileSync(userFile,'utf8'):'';
  writeFileSync(userFile,connectionPreferences(original),{mode:0o600});
  const socket=privateFirefoxSocket(bridgeDir);
  try {
  let startedFresh=false;
  const attach=()=>NormalFirefox.attach({socketPath:socket.connectPath,profileDir:profile,bridgeDir,hideStartupWindows:startedFresh,ownsProcess:true});
  if(existsSync(socket.file)&&lstatSync(socket.file).isSocket())try{return await attach()}catch(error){if(!['ECONNREFUSED','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  if(profileIsOpen(profile))throw Error('The launcher Firefox profile is already open without its private connection. Close that launcher browser window and try again.');
  startedFresh=true;
  // --no-remote prevents forwarding this request to the personal browser.
  const child=spawn(binary,['--no-remote','--profile',profile,'--start-debugger-server',socket.listenPath],{stdio:'ignore',detached:true,cwd:socket.cwd});let launchError:Error|undefined;child.once('error',e=>{launchError=e});child.unref();
  const deadline=Date.now()+20000;let last:Error|undefined;
  while(Date.now()<deadline){if(launchError)throw launchError;if(existsSync(socket.file))try{return await attach()}catch(error){last=error as Error;if(!['ECONNREFUSED','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))throw error;}await new Promise(r=>setTimeout(r,200))}
  throw Error(last?.message??'The installed Firefox did not start its private launcher connection.');
  } finally { socket.close(); }
}
