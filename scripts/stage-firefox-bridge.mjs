import {copyFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function stageFirefoxBridge(){
  const target=join(root,'vendor/firefox');if(!existsSync(target))return;
  for(const [source,dest] of [['autoconfig.js','defaults/pref/cgl-autoconfig.js'],['cgl-browser.cfg','cgl-browser.cfg'],['CglBrowserChild.sys.mjs','cgl-browser/CglBrowserChild.sys.mjs'],['CglBackground.sys.mjs','cgl-browser/CglBackground.sys.mjs']]){const p=join(target,dest);mkdirSync(dirname(p),{recursive:true});copyFileSync(join(root,'resources/firefox',source),p);}
}
stageFirefoxBridge();
