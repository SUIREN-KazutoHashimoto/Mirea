import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeCollectionView,loadCollectionView,saveCollectionView,mountCollectionView} from '../web/src/collection-view.js';
import {seriesPath,isInSeries} from '../web/src/series-tree.js';
import {collectionEntries} from '../web/src/library-collection.js';
import {appendSeriesAssets} from '../web/src/series-ui.js';
test('2/3-column or list and full/compact preferences are independent, bounded and survive storage failure/reload',()=>{
 const storage={getItem(){return this.value??null;},setItem(_,v){this.value=v;}};
 assert.deepEqual(loadCollectionView(storage),{layout:'grid2',details:'full'});
 saveCollectionView({layout:'grid3',details:'compact',arbitrary:'discard'},storage);assert.deepEqual(loadCollectionView(storage),{layout:'grid3',details:'compact'});
 assert.deepEqual(normalizeCollectionView({layout:'bad',details:'bad'}),{layout:'grid2',details:'full'});
 saveCollectionView({layout:'grid5',details:'compact'},storage);assert.deepEqual(loadCollectionView(storage),{layout:'grid5',details:'compact'});saveCollectionView({layout:'grid3',details:'compact'},storage);
 const bad={getItem(){throw Error();},setItem(){throw Error();}};assert.equal(loadCollectionView(bad).layout,'grid2');assert.equal(saveCollectionView({layout:'list',details:'full'},bad).layout,'list');
 const controls={};const container={set innerHTML(_){controls['.collection-layout']={};controls['.collection-details']={};},querySelector:s=>controls[s]},grid={dataset:{}};let changes=0;
 mountCollectionView({container,grid,storage,onChanged:()=>changes++});assert.equal(grid.dataset.layout,'grid3');
 controls['.collection-layout'].value='list';controls['.collection-layout'].onchange();assert.equal(grid.dataset.layout,'list');assert.equal(grid.dataset.details,'compact');assert.equal(changes,1);
 controls['.collection-details'].value='full';controls['.collection-details'].onchange();assert.deepEqual(loadCollectionView(storage),{layout:'list',details:'full'});
});
test('nested folders display immediate children only, use recursive cover/count, preserve filtered bulk assets and never duplicate leaves',()=>{
 const series=[{id:'a',title:'Parent'},{id:'b',title:'Child',parentId:'a'},{id:'c',title:'Grandchild',parentId:'b'},{id:'empty',title:'Empty',parentId:'a'}];
 const assets=[{id:'1',title:'One',series:{id:'a',position:1}},{id:'2',title:'Two',series:{id:'b',position:1}},{id:'3',title:'Three',series:{id:'c',position:1}},{id:'4',title:'Alone'}];
 const before=JSON.stringify([series,assets]),root=collectionEntries(assets,series);
 assert.deepEqual(new Set(root.map(r=>r.id??r.item.id)),new Set(['a','4']));assert.equal(root.find(r=>r.id==='a').assetCount,3);
 const inside=collectionEntries(assets.filter(i=>i.series),series,{parentId:'a',allItems:assets});assert.deepEqual(new Set(inside.map(r=>r.id??r.item.id)),new Set(['b','empty','1']));
 const child=inside.find(r=>r.id==='b');assert.equal(child.assetCount,2);assert.equal(child.cover.id,'2');
 const leaf=collectionEntries([assets[2]],series,{parentId:'c',allItems:assets});assert.equal(leaf.length,1);assert.equal(leaf[0].item.id,'3');
 assert.equal(collectionEntries([assets[2]],series,{filter:'video',allItems:assets})[0].matchedCount,1);
 assert.equal(isInSeries(series,'c','a'),true);assert.deepEqual(seriesPath(series,'c').map(s=>s.id),['a','b','c']);assert.equal(JSON.stringify([series,assets]),before);
 assert.equal(seriesPath([{id:'x',parentId:'y'},{id:'y',parentId:'x'}],'x').length,2,'defensive UI guard');
});
test('bulk series selection appends multiple unique valid assets, retains labels/order and enforces the server size cap',()=>{
 const first=[{assetId:'one',label:'第1話'}],map=new Map([['one',{}],['two',{}],['three',{}]]);
 assert.deepEqual(appendSeriesAssets(first,['two','three','two','missing','one'],map),[{assetId:'one',label:'第1話'},{assetId:'two',label:''},{assetId:'three',label:''}]);assert.equal(first.length,1);
 assert.throws(()=>appendSeriesAssets(Array.from({length:1000},(_,i)=>({assetId:String(i)})),['two'],map),/1,000/);
});
test('layout CSS supports mobile 3-column/list and compact hides metadata without removing pending protection or card menus; audio motion remains foreground/reduced-motion gated',async()=>{
 const [css,main,audio,native]=await Promise.all(['../web/src/collection-view.css','../web/src/main.js','../web/src/audio-player.css','../android/app/src/main/java/com/suiren/mirea/playback/AudioBackdrop.java'].map(p=>readFile(new URL(p,import.meta.url),'utf8')));
 for(const marker of ['data-layout="grid3"','data-layout="list"','data-details="compact"','repeat(3,minmax(0,1fr))','.card-meta','.card-shelf','.card-progress'])assert(css.includes(marker),marker);
 for(const marker of ['mountCollectionView','parentId:selectedSeries?.id','isInSeries(series,item.series?.id,activeSeries)','current?.parentId','aria-disabled="true"','mountAssetHold'])assert(main.includes(marker),marker);
 assert(audio.includes('audio-drift 8s'));assert(audio.includes('prefers-reduced-motion:reduce'));assert(native.includes('/8000d'));assert(native.includes('areAnimatorsEnabled()'));assert(native.includes('getCallback()==null'));
});
