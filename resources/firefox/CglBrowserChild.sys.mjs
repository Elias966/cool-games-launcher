// Trusted launcher queries run in a content sandbox, never with chrome access.
const {setTimeout,clearTimeout}=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
export class CglBrowserChild extends JSWindowActorChild {
  elements=new Map(); elementIds=new WeakMap(); nextElement=0; sandbox=null; keys=new Set(); pointer={x:0,y:0}; tip=null;
  encode(value,depth=0) {
    if(value==null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value??null;
    if(depth>20)throw Error('Browser result is too deeply nested');
    if(value.nodeType===1){let id=this.elementIds.get(value);if(!id){id=String(++this.nextElement);this.elementIds.set(value,id);this.elements.set(id,new WeakRef(value));}if(this.elements.size>5000)for(const [key,ref] of this.elements)if(!ref.deref()?.isConnected)this.elements.delete(key);return {__cglElement:id};}
    if(Array.isArray(value))return value.map(v=>this.encode(v,depth+1));
    if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.encode(v,depth+1)]));
    return null;
  }
  decode(value) {
    if(value&&typeof value==='object'&&typeof value.__cglElement==='string'){
      const element=this.elements.get(value.__cglElement)?.deref();if(!element?.isConnected)throw Error('Element is no longer on the page');return Cu.waiveXrays(element);
    }
    if(Array.isArray(value))return value.map(v=>this.decode(v));
    return value;
  }
  async receiveMessage({data:p}) {
    const win=this.contentWindow;
    if(p.op==='frame'){
      // Deliver a rendering tick at the real current time for an unmapped
      // native window. Always restore the normal clock before returning.
      try{win.windowUtils.advanceTimeAndRefresh(0)}finally{win.windowUtils.restoreNormalRefresh()}
      return null;
    }
    if(p.op==='viewport')return {w:win.innerWidth,h:win.innerHeight,dpr:win.devicePixelRatio||1};
    if(p.op==='actions'){for(const action of p.actions)await this.input(action);return null;}
    if(p.op!=='script')throw Error('Unknown content command');
    if(!this.sandbox)this.sandbox=Cu.Sandbox(win,{sandboxPrototype:win,wantXrays:false});
    this.sandbox.__cglArgs=Cu.cloneInto((p.args||[]).map(v=>this.decode(v)),this.sandbox,{wrapReflectors:true,cloneFunctions:true});
    try {
      let result;
      if(p.async)result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Browser script timed out')),p.timeout||15000);this.sandbox.__cglArgs.push(Cu.cloneInto(v=>{clearTimeout(timer);resolve(v)},this.sandbox,{cloneFunctions:true}));try{Cu.evalInSandbox(`(function(){${p.source}\n}).apply(window,__cglArgs)`,this.sandbox);}catch(error){clearTimeout(timer);reject(error);}});
      else result=await Cu.evalInSandbox(`(function(){${p.source}\n}).apply(window,__cglArgs)`,this.sandbox);
      return this.encode(result);
    } finally {delete this.sandbox.__cglArgs;}
  }
  async input(a) {
    const win=this.contentWindow,utils=win.windowUtils;
    const modifiers=()=> (this.keys.has('\uE009')?2:0)|(this.keys.has('\uE008')?1:0)|(this.keys.has('\uE00A')?4:0)|(this.keys.has('\uE03D')?8:0);
    const mouse=(type,x,y,button,count)=>{
      if(typeof win.synthesizeMouseEvent==='function')return win.synthesizeMouseEvent(type,x,y,{button,clickCount:count,modifiers:modifiers(),identifier:utils.DEFAULT_MOUSE_POINTER_ID,inputSource:win.MouseEvent.MOZ_SOURCE_MOUSE},{isDOMEventSynthesized:true,isWidgetEventSynthesized:false,isAsyncEnabled:false});
      return utils.sendMouseEvent(type,x,y,button,count,modifiers());
    };
    if(a.kind==='move'){this.pointer={x:a.x,y:a.y};mouse('mousemove',a.x,a.y,0,0);return;}
    if(a.kind==='press'||a.kind==='release'){mouse(a.kind==='press'?'mousedown':'mouseup',this.pointer.x,this.pointer.y,a.button,1);return;}
    if(a.kind==='scroll'){utils.sendWheelEvent(a.x,a.y,a.dx,a.dy,0,0,modifiers(),0,0,0);return;}
    if(!this.tip){this.tip=Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);if(!this.tip.beginInputTransactionForTests(win,null))throw Error('Could not focus the browser input');}
    const names={'\uE007':['Enter','Enter',13],'\uE006':['Enter','Enter',13],'\uE003':['Backspace','Backspace',8],'\uE004':['Tab','Tab',9],'\uE00C':['Escape','Escape',27],'\uE012':['ArrowLeft','ArrowLeft',37],'\uE013':['ArrowUp','ArrowUp',38],'\uE014':['ArrowRight','ArrowRight',39],'\uE015':['ArrowDown','ArrowDown',40],'\uE00E':['PageUp','PageUp',33],'\uE00F':['PageDown','PageDown',34],'\uE010':['End','End',35],'\uE011':['Home','Home',36],'\uE017':['Delete','Delete',46],'\uE009':['Control','ControlLeft',17],'\uE008':['Shift','ShiftLeft',16],'\uE00A':['Alt','AltLeft',18],'\uE03D':['Meta','MetaLeft',91],'\uE00D':[' ','Space',32]};
    const keyEvent=(key,type)=>{const [name,code,keyCode]=names[key]||[key,/^[a-z]$/i.test(key)?'Key'+key.toUpperCase():/^[0-9]$/.test(key)?'Digit'+key:'',key.toUpperCase().charCodeAt(0)];return new win.KeyboardEvent(type,{key:name,code,keyCode,ctrlKey:this.keys.has('\uE009'),shiftKey:this.keys.has('\uE008'),altKey:this.keys.has('\uE00A'),metaKey:this.keys.has('\uE03D')});};
    if(a.kind==='down'){this.keys.add(a.key);this.tip.keydown(keyEvent(a.key,'keydown'));return;}
    if(a.kind==='up'){this.tip.keyup(keyEvent(a.key,'keyup'));this.keys.delete(a.key);return;}
    if(a.kind==='text'){
      if(!this.keys.size&&!/[\uE000-\uE05F]/.test(a.text)){this.tip.commitCompositionWith(a.text);return;}
      for(const key of a.text){this.tip.keydown(keyEvent(key,'keydown'));this.tip.keyup(keyEvent(key,'keyup'));}
    }
  }
}

// The attached system Firefox uses its own actor name in the same process.
export class CglPersonalBrowserChild extends CglBrowserChild {}

export class CglLegacyBackgroundChild extends CglBrowserChild {}
