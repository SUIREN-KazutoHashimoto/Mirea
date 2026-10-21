import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFragment} from 'parse5';
import {openUploadDialog} from '../web/src/upload-ui.js';
// Minimal component DOM harness, not browser/file-picker automation. parse5
// decodes the real rendered HTML; only selectors used by this component exist.
class Element {
 constructor(ast,parent=null){this.tag=ast.nodeName;this.parent=parent;this.attrs=new Map((ast.attrs??[]).map(a=>[a.name,a.value]));this.children=(ast.childNodes??[]).map(n=>new Element(n,this));this.dataset=Object.fromEntries([...this.attrs].filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));this.hidden=this.attrs.has('hidden');this.disabled=this.attrs.has('disabled');this.checked=this.attrs.has('checked');this.classList={add(){},remove(){}};this.text=ast.value??'';this.listeners=new Map();}
 get isConnected(){return this.parent?this.parent.isConnected:this.live===true;}
 get innerHTML(){return '';}set innerHTML(html){this.children=parseFragment(html).childNodes.map(n=>new Element(n,this));}
 get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}set textContent(value){this.text=String(value);this.children=[];}
 get value(){if(this.val!==undefined)return this.val;if(this.tag==='select')return this.querySelector('option[selected]')?.attrs.get('value')??this.querySelector('option')?.attrs.get('value')??'';return this.attrs.get('value')??'';}set value(v){this.val=v;}
 get elements(){return Object.fromEntries(this.querySelectorAll('[name]').map(el=>[el.attrs.get('name'),el]));}
 matches(selector){const tag=selector.match(/^[a-z]+/)?.[0],id=selector.match(/#([\w-]+)/)?.[1],classes=[...selector.matchAll(/\.([\w-]+)/g)].map(m=>m[1]),attrs=[...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];return (!tag||this.tag===tag)&&(!id||this.attrs.get('id')===id)&&classes.every(c=>(this.attrs.get('class')??'').split(' ').includes(c))&&attrs.every(([,key,value])=>this.attrs.has(key)&&(value===undefined||this.attrs.get(key)===value));}
 querySelectorAll(selector){const selectors=selector.split(',').map(s=>s.trim()),out=[];const visit=node=>{for(const child of node.children){if(selectors.some(s=>child.matches(s)))out.push(child);visit(child);}};visit(this);return out;}querySelector(s){return this.querySelectorAll(s)[0]??null;}
 addEventListener(event,fn){const list=this.listeners.get(event)??[];list.push(fn);this.listeners.set(event,list);}close(){for(const fn of this.listeners.get('close')??[])fn();this.live=false;}
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};},tick=()=>new Promise(r=>setImmediate(r)),file=name=>new File(['fixture'],name,{lastModified:1});
const esc=value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function mount(overrides={}){let changes=0;const node=openUploadDialog({dialog:(_,html)=>{const root=new Element(parseFragment(html));root.live=true;return root;},api:async()=>({uploads:[]}),upload:()=>({promise:Promise.resolve()}),shelves:[{id:'shelf',name:'Shelf'}],config:{maxUploadBytes:1000,maxBookPages:500,maxImageBytes:1000},esc,bytes:n=>n+'B',icon:()=>'',processingLabel:()=> '後処理',isCurrent:()=>true,onChanged:async()=>{changes++;},toast(){},...overrides});return {node,get changes(){return changes;},select(files){node.querySelector('form').elements.file.files=files;node.querySelector('form').elements.file.onchange();},submit(){return node.querySelector('form').onsubmit({preventDefault(){}});}};}

test('upload component renders mixed jobs, editable titles and page controls, then publishes in three bounded workers',async()=>{
 const pending=[],calls=[];const ui=mount({upload:(shelf,files,title,onProgress,options)=>{const d=deferred();pending.push(d);calls.push({shelf,files,title,options});onProgress(100,{stage:'thumbnail'});return {promise:d.promise,processing:true,detach(){d.reject(Error('detach'));},abort(){d.reject(Error('abort'));}};}});
 ui.select([file('one.pdf'),file('two.pdf'),file('clip.mp4'),file('10.png'),file('2.png')]);assert.equal(ui.node.querySelectorAll('[data-entry-title]').length,4);assert.equal(ui.node.querySelector('[data-page-up="0"]').disabled,true);assert.equal(ui.node.querySelector('[data-page-down="1"]').disabled,true);
 const title=ui.node.querySelector('[data-entry-title="0"]');title.value='Edited title';title.oninput();ui.node.querySelector('[data-page-up="1"]').onclick();const done=ui.submit();await tick();assert.equal(calls.length,3);assert.equal(calls[0].title,'Edited title');assert.equal(ui.node.querySelector('[data-entry-title="0"]').disabled,true);assert.equal(ui.node.querySelector('form').elements.file.disabled,true);
 pending.slice(0,3).forEach(d=>d.resolve());await tick();assert.equal(calls.length,4);assert.deepEqual(calls[3].files.map(f=>f.name),['10.png','2.png']);assert(calls.every(c=>c.options.retainOriginal));pending[3].resolve();await done;assert.equal(ui.node.isConnected,false);assert(ui.changes>0);
});
test('upload component retry freezes prior choices and never resends a completed asset',async()=>{
 const calls=[];let failure=true;const ui=mount({upload:(_,files)=>{calls.push(files[0].name);return {promise:failure&&files[0].name==='one.pdf'?Promise.reject(Error('network fixture')):Promise.resolve()};}});ui.select([file('one.pdf'),file('two.pdf')]);await ui.submit();assert.equal(ui.node.isConnected,true);assert.equal(ui.node.querySelector('form').elements.file.disabled,true);assert.equal(ui.node.querySelector('[type="submit"]').textContent,'未完了だけ再試行');assert(ui.node.querySelector('.upload-entry-status').textContent.includes('network fixture'));failure=false;await ui.submit();assert.deepEqual(calls,['one.pdf','two.pdf','one.pdf']);assert.equal(ui.node.isConnected,false);
});
test('closing upload component during its asynchronous preflight never starts a transfer afterwards',async()=>{
 const preflight=deferred();let starts=0;const ui=mount({api:()=>preflight.promise,upload:()=>{starts++;assert.fail('late upload');}});ui.select([file('one.pdf')]);const done=ui.submit();ui.node.close();preflight.resolve({uploads:[]});await done;assert.equal(starts,0);
});
