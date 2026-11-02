export const repeatModes=['off','one','series'];
export function normalizeModes(value={}){return {repeat:repeatModes.includes(value.repeat)?value.repeat:'off',shuffle:value.shuffle===true};}
export function loadPlaybackModes(storage,key){try{return normalizeModes(JSON.parse(storage.getItem('mirea.playback-modes.'+key)||'{}'));}catch{return normalizeModes();}}
export function savePlaybackModes(storage,key,modes){try{storage.setItem('mirea.playback-modes.'+key,JSON.stringify(normalizeModes(modes)));}catch{}}
const timed=context=>(context?.items??[]).filter(i=>['audio','video'].includes(i.kind));
const shuffled=(values,random)=>{const out=[...values];for(let i=out.length-1;i>0;i--){const j=Math.max(0,Math.min(i,Math.floor(random()*(i+1))));[out[i],out[j]]=[out[j],out[i]];}return out;};
// Only order/modes live here. Every transition still needs fresh server ACL data.
export function createPlaybackOrder({scope='',modes={},random=Math.random}={}){
  let settings=normalizeModes(modes),state={series:null,shuffle:false,bag:[],seen:[],history:[],index:-1},revision=0;
  return {scope,get modes(){return {...settings};},setModes(value){settings=normalizeModes({...settings,...value});revision++;},
    canMove(context,id,direction=1){if(!settings.shuffle&&settings.repeat!=='series'){const all=context?.items??[],at=all.findIndex(i=>i.id===id);return Boolean(context?.series&&at>=0&&all[at+direction]);}const items=timed(context),index=items.findIndex(i=>i.id===id);if(!context?.series||index<0)return false;if(settings.shuffle){const validState=state.series===context.series.id&&state.shuffle===settings.shuffle&&state.history[state.index]===id,history=validState?state.history:[],seen=validState?state.seen:[];return direction<0?history.slice(0,state.index).some(i=>items.some(a=>a.id===i)):history.slice(state.index+1).some(i=>items.some(a=>a.id===i))||settings.repeat==='series'||items.some(i=>i.id!==id&&!seen.includes(i.id));}return Boolean(items[index+direction])||settings.repeat==='series';},
    plan(context,id,direction=1){
      const items=timed(context),ids=items.map(i=>i.id),current=ids.indexOf(id),series=context?.series?.id;
      if(!series||current<0)return null;
      let next={...state,bag:[...state.bag],seen:[...state.seen],history:[...state.history]};
      if(next.series!==series||next.shuffle!==settings.shuffle||next.history[next.index]!==id)next={series,shuffle:settings.shuffle,bag:[],seen:[id],history:[id],index:0};
      let selected;
      if(!settings.shuffle){let index=current+direction;if(settings.repeat==='series')index=(index+ids.length)%ids.length;selected=ids[index];}
      else{
        next.bag=next.bag.filter(i=>ids.includes(i));next.seen=next.seen.filter(i=>ids.includes(i));
        if(direction<0){for(let i=next.index-1;i>=0;i--)if(ids.includes(next.history[i])){next.index=i;selected=next.history[i];break;}}
        else if(next.index<next.history.length-1){for(let i=next.index+1;i<next.history.length;i++)if(ids.includes(next.history[i])){next.index=i;selected=next.history[i];break;}}
        if(!selected&&direction>0){
          const additions=ids.filter(i=>!next.seen.includes(i)&&!next.bag.includes(i));next.bag.push(...shuffled(additions,random));
          if(!next.bag.length&&settings.repeat==='series'){next.seen=[id];next.bag=shuffled(ids.filter(i=>i!==id),random);if(!next.bag.length)next.bag=[id];}
          selected=next.bag.shift();if(selected){next.seen.push(selected);next.history=next.history.slice(0,next.index+1);next.history.push(selected);if(next.history.length>2000)next.history.shift();next.index=next.history.length-1;}
        }
      }
      const target=items.find(i=>i.id===selected);if(!target)return null;const epoch=revision;
      return {target,commit(){if(revision!==epoch)return false;state=next;return true;}};
    }
  };
}
