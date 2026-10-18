// Background rendering for the existing WebDriver backend. The same page actor
// serves normal/system Firefox. Ticks use wall time and never leave test clocks
// enabled; native human browsing keeps Firefox's normal refresh driver.
const {setInterval,clearInterval}=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
let registered=false;
export function hiddenRenderer(win){
  if(win.__cglHiddenRenderer)return win.__cglHiddenRenderer;
  if(!registered){
    ChromeUtils.registerWindowActor('CglLegacyBackground',{child:{esModuleURI:'resource://cgl-browser/CglBrowserChild.sys.mjs'},allFrames:true,includeChrome:false,safeForUntrustedWebProcess:true,remoteTypes:['web','webIsolated','webCOOP+COEP','privilegedabout'],matches:['http://*/*','https://*/*','about:blank','about:newtab']});registered=true;
  }
  let timer=null,lastUse=0,busy=false;
  const stop=()=>{if(timer)clearInterval(timer);timer=null;};
  const controller={touch(hidden){
    if(!hidden){stop();return;}
    lastUse=Date.now();if(timer)return;
    timer=setInterval(async()=>{
      if(win.closed||Date.now()-lastUse>2500){stop();return;}
      if(busy)return;busy=true;
      try{await win.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('CglLegacyBackground').sendQuery('command',{op:'frame'});}catch{}finally{busy=false;}
    },50);
  },stop};
  win.addEventListener('unload',stop,{once:true});win.__cglHiddenRenderer=controller;return controller;
}
