const maxFadeMs=2400;
const trackPath=/^\/api\/v1\/radio\/stations\/([a-f0-9-]{36})\/tracks\/[a-f0-9-]+\/content$/;

export function readLiveFade(program){
  const fade=program?.crossfade;
  const from=trackPath.exec(program?.mediaUrl??''), to=trackPath.exec(fade?.mediaUrl??'');
  if(!fade||!from||!to||from[1]!==to[1]||fade.mediaUrl===program.mediaUrl||
     !Number.isSafeInteger(program.startTime)||!Number.isSafeInteger(program.durationMs)||
     !Number.isSafeInteger(fade.startTime)||!Number.isSafeInteger(fade.durationMs)||
     fade.durationMs<250||fade.durationMs>maxFadeMs||fade.startTime<=program.startTime||
     fade.startTime+fade.durationMs!==program.startTime+program.durationMs)return null;
  return fade;
}

export function liveFadeGains(progress){
  const q=Math.max(0,Math.min(1,progress))*Math.PI/2;
  const a=Math.cos(q),b=Math.sin(q),headroom=Math.max(1,a+b);
  return [a/headroom,b/headroom];
}

function metadata(audio,signal){
  return new Promise((resolve,reject)=>{
    const clean=()=>{audio.removeEventListener('loadedmetadata',ready);audio.removeEventListener('error',failed);signal.removeEventListener('abort',abort);};
    const ready=()=>{clean();resolve();};
    const failed=()=>{clean();reject(Error('Secondary media unavailable'));};
    const abort=()=>{clean();reject(signal.reason);};
    audio.addEventListener('loadedmetadata',ready,{once:true});audio.addEventListener('error',failed,{once:true});
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
}

function wait(ms,signal){
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason);};
    const timer=setTimeout(()=>{cleanup();resolve();},Math.max(0,ms));
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
}

export function createLiveCrossfader(first,{makeAudio=()=>new Audio(),Context=globalThis.AudioContext,delay=wait,timeout=ms=>AbortSignal.timeout(ms)}={}){
  if(typeof Context!=='function')return null;
  let ctx;
  try{
    ctx=new Context();
    const master=ctx.createGain();
    master.connect(ctx.destination);
    function deck(audio){
      const gain=ctx.createGain();
      ctx.createMediaElementSource(audio).connect(gain).connect(master);
      audio.volume=1;
      return {audio,gain,url:null,mediaUrl:null,started:false};
    }
    let spare=deck(makeAudio()), primary=deck(first), pending;
    const gain=(deck,value)=>{
      deck.gain.gain.cancelScheduledValues(ctx.currentTime);
      deck.gain.gain.setValueAtTime(value,ctx.currentTime);
    };
    const reset=(deck)=>{
      deck.audio.pause();deck.audio.removeAttribute('src');deck.audio.load();
      if(deck.url)URL.revokeObjectURL(deck.url);
      deck.url=null;deck.mediaUrl=null;deck.started=false;
    };
    function cancel(){
      pending?.abort();pending=null;
      gain(primary,1);gain(spare,0);reset(spare);
    }
    function take(url){
      if(!spare.started||spare.mediaUrl!==url||spare.audio.paused)return null;
      // A renewed, authorized schedule promotes the already-audible deck without
      // rewinding its first seconds or restarting the transition.
      pending?.abort();pending=null;
      [primary,spare]=[spare,primary];
      const result={audio:primary.audio,url:primary.url};
      primary.url=null;primary.mediaUrl=null;primary.started=false;
      gain(primary,1);gain(spare,0);
      return result;
    }
    function schedule(fade,clock,{signal,load}){
      cancel();
      if(!fade||signal.aborted)return;
      const controller=pending=new AbortController(), deck=spare;
      const work=AbortSignal.any([signal,controller.signal]);
      const end=fade.startTime+fade.durationMs;
      const current=()=>pending===controller&&!work.aborted;
      void(async()=>{
        try{
          if(clock()>=end-250)return;
          const prefetchIn=fade.startTime-clock()-10_000;
          if(prefetchIn>0)await delay(prefetchIn,work);
          if(!current()||clock()>=end-250)return;
          const loading=AbortSignal.any([work,timeout(12_000)]);
          const blob=await load(fade.mediaUrl,loading);
          if(!current()||clock()>=end-250)return;
          deck.url=URL.createObjectURL(blob);deck.mediaUrl=fade.mediaUrl;
          const ready=metadata(deck.audio,loading);
          deck.audio.preload='auto';deck.audio.src=deck.url;
          await ready;
          if(clock()<fade.startTime)await delay(fade.startTime-clock(),work);
          if(!current()||clock()>=end-250||ctx.state!=='running')return;
          deck.audio.currentTime=Math.max(0,clock()-fade.startTime)/1000;
          await deck.audio.play();
          if(!current()||clock()>=end-200)return;
          deck.started=true;
          const progress=Math.max(0,(clock()-fade.startTime)/fade.durationMs);
          const seconds=(end-clock())/1000,start=ctx.currentTime;
          for(let i=0;i<=24;i++){
            const [a,b]=liveFadeGains(progress+(1-progress)*i/24);
            const method=i===0?'setValueAtTime':'linearRampToValueAtTime';
            primary.gain.gain[method](a,start+seconds*i/24);
            deck.gain.gain[method](b,start+seconds*i/24);
          }
        }catch{/* Continue regular playback when the spare deck cannot play. */}
        finally{
          if(pending===controller&&!deck.started){pending=null;gain(primary,1);gain(deck,0);reset(deck);}
        }
      })();
    }
    gain(primary,1);gain(spare,0);
    return {take,schedule,cancel,volume(value){master.gain.value=value;},resume(){void ctx.resume().catch(()=>{});},
      close(){cancel();void ctx.close().catch(()=>{});}};
  }catch{void ctx?.close().catch(()=>{});return null;}
}
