import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {createLiveCrossfader, liveFadeGains, readLiveFade} from '../web/src/radio-crossfade.js';

for(let i=0;i<=100;i++){
  const [a,b]=liveFadeGains(i/100);
  assert(a>=0&&b>=0&&a+b<=1.0000001);
  if(i>0&&i<100)assert(Math.abs(b/a-Math.tan(i/100*Math.PI/2))<1e-9);
}
const base='/api/v1/radio/stations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tracks/', srcA=base+'aa/content', srcB=base+'bb/content';
const good={startTime:10000,durationMs:6000,mediaUrl:srcA,crossfade:{startTime:13600,durationMs:2400,mediaUrl:srcB,title:'Tone B'}};
assert.equal(readLiveFade(good),good.crossfade);
assert.equal(readLiveFade({...good,crossfade:{...good.crossfade,mediaUrl:'/other'}}),null);
assert.equal(readLiveFade({...good,crossfade:{...good.crossfade,startTime:13601}}),null);


async function checkLongTrack(){
  let wall=100000, fetches=0, timeoutCalls=0;
  const delays=[];
  const delay=(ms,signal)=>new Promise((resolve,reject)=>{
    delays.push({ms,resolve});
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
  class Audio extends EventTarget{
    volume=1;paused=true;currentTime=0;
    set src(_value){queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));}
    pause(){this.paused=true;}
    async play(){this.paused=false;}
    removeAttribute(){}
    load(){}
  }
  class Context{
    destination={};state='running';currentTime=0;
    createGain(){return {connect(){},gain:{cancelScheduledValues(){},setValueAtTime(){},linearRampToValueAtTime(){}}};}
    createMediaElementSource(){return {connect(node){return node;}};}
    async close(){}
  }
  const inDeck=new Audio();
  const mixer=createLiveCrossfader(new Audio(),{makeAudio:()=>inDeck,Context,delay,timeout:(ms)=>{
    timeoutCalls++;assert.equal(ms,12000);return new AbortController().signal;
  }});
  const signal=new AbortController().signal,fade={startTime:wall+90_000,durationMs:2400,mediaUrl:srcB};
  mixer.schedule(fade,()=>wall,{signal,load:async()=>{fetches++;return new Blob(['synthetic']);}});
  assert.equal(delays[0].ms,80_000);assert.equal(timeoutCalls,0);assert.equal(fetches,0);
  wall+=80_000;delays.shift().resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fetches,1);assert.equal(timeoutCalls,1);assert.equal(delays[0].ms,10000);
  assert.equal(inDeck.paused,true);
  wall+=10_000;delays.shift().resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(inDeck.paused,false);assert.equal(inDeck.currentTime,0);
  mixer.close();
  assert.equal(inDeck.paused,true);
}
await checkLongTrack();

let server,browser;
const temporary=await mkdtemp(join(tmpdir(),'mirea-crossfade-ui-'));
try{
  server=await createServer({root:'web',configFile:false,cacheDir:join(temporary,'vite'),server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
  server.middlewares.use('/crossfade-fixture',(_req,res)=>{
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated crossfade fixture</title>');
  });
  await server.listen();
  const origin='http://127.0.0.1:'+server.httpServer.address().port;
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
  async function fixture(mode){
    const ctx=await browser.newContext({serviceWorkers:'block'});
    await ctx.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
    const page=await ctx.newPage(), errors=[];
    page.on('pageerror',err=>errors.push(err.message));
    await page.goto(origin+'/crossfade-fixture');
    await page.evaluate(async({mode,srcA,srcB})=>{
      const Context=window.AudioContext;
      window.AudioContext=class extends Context{
        constructor(){super();this.tap=this.createAnalyser();this.tap.fftSize=4096;this.tap.smoothingTimeConstant=0;window.audioProbe=this;}
        createGain(){
          const gain=super.createGain(),connect=gain.connect.bind(gain);
          gain.connect=(dest,...args)=>{
            if(dest===this.destination){connect(this.tap);window.masterProbe=gain;}
            return connect(dest,...args);
          };
          return gain;
        }
      };
      window.spectrum=()=>{
        const ctx=window.audioProbe;
        if(!ctx)return null;
        const dbs=new Float32Array(ctx.tap.frequencyBinCount);ctx.tap.getFloatFrequencyData(dbs);
        const peak=f=>{const i=Math.round(f*ctx.tap.fftSize/ctx.sampleRate);return Math.max(dbs[i-1],dbs[i],dbs[i+1]);};
        return [peak(440),peak(880)];
      };
      const tone=(f,seconds)=>{
        const rate=12000,n=rate*seconds,bytes=new ArrayBuffer(44+n*2),s=new DataView(bytes);
        const text=(at,x)=>Array.from(x,(y,i)=>s.setUint8(at+i,y.charCodeAt(0)));
        text(0,'RIFF');s.setUint32(4,36+n*2,true);text(8,'WAVE');text(12,'fmt ');
        s.setUint32(16,16,true);s.setUint16(20,1,true);s.setUint16(22,1,true);
        s.setUint32(24,rate,true);s.setUint32(28,rate*2,true);s.setUint16(32,2,true);s.setUint16(34,16,true);
        text(36,'data');s.setUint32(40,n*2,true);
        for(let i=0;i<n;i++)s.setInt16(44+i*2,Math.floor(8000*Math.sin(i/rate*f*Math.PI*2)),true);
        return new Blob([bytes],{type:'audio/wav'});
      };
      const a=tone(440,6),b=tone(880,10),{openRadio}=await import('/src/radio.js');
      const loadCalls=[];let epoch;
      window.fadeProbe={loadCalls,get epoch(){return epoch;}};
      const dialogs=(title,markup,cls)=>{const node=document.createElement('dialog');node.className=cls;node.setAttribute('aria-label',title);node.innerHTML=markup;document.body.append(node);node.showModal();return node;};
      const headers={'X-Mirea-Radio-Share':'synthetic-fixture'};
      openRadio({dialog:dialogs,sessionRevision:()=>1,crossfadeCapable:mode!=='disabled',headers,
        api:async()=>{
          const now=Date.now();epoch??=now;
          const before=now-epoch<6000;
          return before?{station:'Fixture FM',title:'Tone A',serverTime:now,startTime:epoch,durationMs:6000,mediaUrl:srcA,
            crossfade:{startTime:epoch+3600,durationMs:2400,mediaUrl:srcB,title:'Tone B'}}
            :{station:'Fixture FM',title:'Tone B',serverTime:now,startTime:epoch+3600,durationMs:10000,mediaUrl:srcB};
        },authenticatedBlob:async(path,signal,authorization)=>{
          if(authorization?.['X-Mirea-Radio-Share']!=='synthetic-fixture'||signal.aborted)throw Error('Fixture auth failure');
          loadCalls.push({path,elapsed:Date.now()-epoch});
          if(path===srcA)return a;
          if(mode==='missing'&&Date.now()-epoch<6000)throw Error('Synthetic secondary fetch failure');
          return b;
        }});
    },{mode,srcA,srcB});
    await page.getByRole('button',{name:'聴く',exact:true}).click();
    await page.locator('[data-radio-title]').getByText('Tone A').waitFor();
    return {ctx,page,errors};
  }
  async function measure(page,ms){await page.waitForFunction(ms=>window.fadeProbe.epoch&&Date.now()-window.fadeProbe.epoch>ms,ms);return page.evaluate(()=>window.spectrum());}
  const [mixed,missing,disabled]=await Promise.all(['mix','missing','disabled'].map(fixture));
  const atCenter=await measure(mixed.page,4750);
  assert(atCenter.every(v=>v> -45),'both independent tones audible: '+atCenter);
  assert(Math.abs(atCenter[0]-atCenter[1])<5,'gain envelope nearly equal at midpoint: '+atCenter);
  const slider=mixed.page.getByRole('slider',{name:'ラジオ音量'});
  await slider.evaluate(el=>{el.value='37';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert(Math.abs(await mixed.page.evaluate(()=>window.masterProbe.gain.value)-0.37)<0.001,'one master volume for both decks');
  const fallback=await measure(missing.page,4800);
  assert(fallback[0]> -40&&fallback[1]< -50,'missing incoming leaves outgoing audible at full gain: '+fallback);
  assert.equal(await disabled.page.locator('dialog audio').count(),1,'legacy player neither mixes nor downloads secondary early');
  assert.equal(await disabled.page.evaluate(src=>window.fadeProbe.loadCalls.filter(x=>x.path===src).length,srcB),0);
  await Promise.all([mixed,missing,disabled].map(async({page})=>page.locator('[data-radio-title]').getByText('Tone B').waitFor()));
  const times=await mixed.page.locator('dialog audio').evaluateAll(list=>list.filter(a=>!a.paused).map(a=>a.currentTime));
  assert.equal(times.length,1);
  assert(times[0]>2.2,'promoted live deck retains its already-broadcast offset');
  assert.equal(await mixed.page.evaluate(src=>window.fadeProbe.loadCalls.filter(x=>x.path===src).length,srcB),1,'no duplicate fetch required after successful promotion');
  for(const {page,ctx,errors} of [mixed,missing,disabled]){
    await page.getByRole('button',{name:'一時停止',exact:true}).click();
    assert(await page.locator('dialog audio').evaluateAll(list=>list.every(a=>a.paused&&!a.hasAttribute('src'))),'pause clears both protected decks');
    assert.deepEqual(errors,[]);
    await ctx.close();
  }
  console.log(JSON.stringify({verified:'Chrome overlapping distinct tones, bounded mixed gains, shared volume, late/unavailable fallback, legacy single deck and exact promotion/cancellation',atCenter,fallback}));
} finally{await browser?.close();await server?.close();await rm(temporary,{recursive:true,force:true});}
