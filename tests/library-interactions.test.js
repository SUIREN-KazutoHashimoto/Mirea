import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mountAssetHold,mountLibraryDrawer} from '../web/src/library-interactions.js';
import {downloadableSnapshot,runBulkDownloads} from '../web/src/bulk-downloads.js';

const event=(type,props={})=>{const e=new Event(type,{cancelable:true});for(const [key,value] of Object.entries(props))Object.defineProperty(e,key,{value});return e;};
class Node extends EventTarget{
  constructor(doc){super();this.doc=doc;this.isConnected=true;this.hidden=false;this.disabled=false;this.attrs=new Map();this.style={values:new Map(),setProperty(k,v){this.values.set(k,v);},removeProperty(k){this.values.delete(k);}};this.classes=new Set();this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),toggle:(n,value)=>value?this.classes.add(n):this.classes.delete(n)};}
  getBoundingClientRect(){return {width:330};}
  setAttribute(k,v){this.attrs.set(k,v);}removeAttribute(k){this.attrs.delete(k);}focus(){this.doc.activeElement=this;}getClientRects(){return this.hidden?[]:[{}];}
  append(button){button.parent=this;}closest(){return this;}
}
test('button-only drawer ignores swipes, keeps focus/close controls and adapts existing actions at responsive breakpoints',()=>{
  const doc=new EventTarget();doc.body={style:{overflow:'scroll'}};doc.querySelector=()=>null;const layout=new Node(doc),panel=new Node(doc),main=new Node(doc),opener=new Node(doc),closer=new Node(doc),backdrop=new Node(doc),slot=new Node(doc),home=new Node(doc),add=new Node(doc),series=new Node(doc);
  const media=new EventTarget();media.matches=false;panel.querySelector=()=>slot;panel.querySelectorAll=()=>[closer,add,series];doc.activeElement=opener;
  const drawer=mountLibraryDrawer({layout,panel,main,opener,closer,backdrop,actions:[add,series],actionHome:home,media,doc});
  assert.equal(opener.hidden,true);assert.equal(panel.inert,false);assert.equal(add.parent,home);drawer.show();assert.equal(drawer.isOpen(),false);
  media.matches=true;media.dispatchEvent(new Event('change'));assert.equal(add.parent,slot);assert.equal(series.parent,slot);assert.equal(panel.inert,true);
  opener.dispatchEvent(new Event('click'));assert.equal(drawer.isOpen(),true);assert.equal(main.inert,true);assert.equal(panel.attrs.get('aria-modal'),'true');assert.equal(doc.activeElement,closer);assert.equal(doc.body.style.overflow,'hidden');
  doc.dispatchEvent(event('keydown',{key:'Tab',shiftKey:true}));assert.equal(doc.activeElement,series);doc.dispatchEvent(event('keydown',{key:'Tab',shiftKey:false}));assert.equal(doc.activeElement,closer);
  doc.dispatchEvent(event('keydown',{key:'Escape'}));assert.equal(drawer.isOpen(),false);assert.equal(panel.inert,true);assert.equal(main.inert,false);assert.equal(doc.activeElement,opener);assert.equal(doc.body.style.overflow,'scroll');
  const target={closest:()=>null},swipe=(from,to)=>{for(const [type,x] of [['pointerdown',from],['pointermove',to],['pointerup',to]]){const pointer=event(type,{target,button:0,isPrimary:true,pointerId:7,clientX:x,clientY:200,timeStamp:x});layout.dispatchEvent(pointer);assert.equal(pointer.defaultPrevented,false,'navigation must not consume gestures');}};
  swipe(20,300);assert.equal(drawer.isOpen(),false,'right swipe must not open');assert.equal(main.inert,false);assert.equal(doc.body.style.overflow,'scroll');assert.equal(layout.style.values.size,0,'no drag styles or width state');
  opener.dispatchEvent(new Event('click'));assert.equal(drawer.isOpen(),true);swipe(300,20);assert.equal(drawer.isOpen(),true,'left swipe must not close');closer.dispatchEvent(new Event('click'));assert.equal(drawer.isOpen(),false);
  opener.dispatchEvent(new Event('click'));backdrop.dispatchEvent(new Event('click'));assert.equal(drawer.isOpen(),false);assert.equal(doc.activeElement,opener);
  drawer.show();media.matches=false;media.dispatchEvent(new Event('change'));assert.equal(drawer.isOpen(),false);assert.equal(add.parent,home);assert.equal(panel.inert,false);assert.equal(main.inert,false);
  drawer.dispose();opener.dispatchEvent(new Event('click'));assert.equal(drawer.isOpen(),false);
});
test('asset hold opens once, suppresses release click, cancels on scroll/multitouch/blur/disposal and leaves keyboard clicks available',()=>{
  let now=0,id=0;const timers=new Map(),doc=new EventTarget();doc.defaultView=new EventTarget();const root=new EventTarget();root.ownerDocument=doc;const button={isConnected:true,dataset:{open:'asset'},contains:target=>target===button,closest:()=>button};
  const options={now:()=>now,setTimer:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimer:key=>timers.delete(key)},advance=ms=>{now+=ms;for(const [key,t] of [...timers])if(t.at<=now){timers.delete(key);t.fn();}},opened=[];
  const hold=mountAssetHold(root,asset=>opened.push(asset),options),pointer=(type,extra={})=>root.dispatchEvent(event(type,{target:button,button:0,isPrimary:true,pointerId:1,clientX:10,clientY:20,...extra}));
  pointer('pointerdown');advance(500);assert.deepEqual(opened,['asset']);pointer('pointerup');const click=event('click',{target:button,detail:1});root.dispatchEvent(click);assert.equal(click.defaultPrevented,true);
  const keyboard=event('click',{target:button,detail:0});root.dispatchEvent(keyboard);assert.equal(keyboard.defaultPrevented,false);
  for(const cancel of ['move','multi','blur','pointercancel','visibility']){
    pointer('pointerdown');if(cancel==='move')pointer('pointermove',{clientY:50});else if(cancel==='multi')pointer('pointermove',{pointerId:2});else if(cancel==='blur')doc.defaultView.dispatchEvent(new Event('blur'));else if(cancel==='visibility')doc.dispatchEvent(new Event('visibilitychange'));else pointer(cancel);advance(600);
  }
  assert.equal(opened.length,1);pointer('pointerdown');hold.dispose();advance(600);assert.equal(opened.length,1);assert.equal(timers.size,0);
  const keyboardHold=mountAssetHold(root,asset=>opened.push(asset),options);const menu=event('keydown',{target:button,key:'F10',shiftKey:true});root.dispatchEvent(menu);assert.equal(menu.defaultPrevented,true);assert.equal(opened.length,2);keyboardHold.dispose();
});
test('bulk downloads snapshot only ready visible assets, skip saved packages, run serially and continue per-item failures',async()=>{
  const items=[{id:'a',title:'A',size:20},{id:'p',pending:true},{id:'a'},{id:'b',title:'B',size:30},{id:'c',title:'C',size:40},{id:'d',title:'D',size:50}];
  const snapshot=downloadableSnapshot(items);items[0].title='changed';assert.equal(snapshot[0].title,'A');assert.deepEqual(snapshot.map(i=>i.id),['a','b','c','d']);
  let active=0;const calls=[],states=[];const result=await runBulkDownloads(snapshot,{list:async()=>[{assetId:'a',state:'ready'},{assetId:'b',state:'downloading'}],download:async(item,progress)=>{
    assert.equal(active++,0);calls.push(item.id);await Promise.resolve();progress({received:10,total:20});active--;if(item.id==='c')throw Error('test failed');
  },changed:value=>states.push({...value})});
  assert.deepEqual(calls,['b','c','d']);assert.equal(result.completed,2);assert.equal(result.skipped,1);assert.equal(result.failed[0].id,'c');assert.equal(result.total,4);assert.equal(result.cancelled,false);
  const tick=states.find(v=>v.received===10);assert.equal(tick.total,4);assert.equal(tick.totalBytes,20);
});
test('bulk cancellation, account changes and authorization/storage failure stop future work without deleting saved data',async()=>{
  const items=[{id:'a'},{id:'b'}];
  for(const mode of ['abort','identity','auth','space']){
    const controller=new AbortController();let valid=true,calls=0;
    const result=await runBulkDownloads(items,{list:async()=>[],signal:controller.signal,isCurrent:()=>valid,download:async()=>{
      calls++;if(mode==='abort'){controller.abort();throw new DOMException('stop','AbortError');}if(mode==='identity'){valid=false;return;}if(mode==='auth')throw Object.assign(Error('expired'),{status:401});throw Object.assign(Error('full'),{name:'QuotaExceededError'});
    }});
    assert.equal(calls,1,mode);assert.equal(result.cancelled,true,mode);
  }
});
test('library integration removes chapter/subtitle action from cards, keeps editable details and respects reduced motion',async()=>{
  const main=await readFile(new URL('../web/src/main.js',import.meta.url),'utf8'),css=await readFile(new URL('../web/src/library-mobile.css',import.meta.url),'utf8');
  const cards=main.slice(main.indexOf('function renderItems('),main.indexOf('function manageSeries('));assert(!cards.includes('openNavigationEditor'));assert(!cards.includes('card-actions'));assert(!cards.includes('data-details'));assert(!cards.includes('data-download='));assert(!cards.includes('data-delete='));assert(cards.includes('openAssetActions'));assert(main.includes('端末のダウンロードを解除'));assert(main.includes('サーバーから作品を削除'));assert(cards.includes('mountAssetHold'));assert(main.includes('detail-navigation'));assert(main.includes('displayedItems=selected'));
  assert(css.includes('.compact-library .library-overview{display:none}'));assert(css.includes('prefers-reduced-motion:reduce'));assert(css.includes('.native-app .pending-art .icon{animation:none}'));assert(!css.includes('infinite'));assert(!css.includes('drawer-dragging'));assert(!css.includes('--drawer-reveal'));assert(!css.includes('translate3d'));
});
