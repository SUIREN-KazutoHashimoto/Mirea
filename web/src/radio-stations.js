import {openRadio} from './radio.js';
import {openRadioTrackPicker} from './radio-track-picker.js';
import {playerIcon} from './player-icons.js';

const labels = {public:'公開',unlisted:'限定公開',private:'非公開'};
const sharePattern = /^#mirea-radio=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
export function openStationLink(options) {
  const link = location.hash.match(sharePattern);
  if(!link)return false;
  history.replaceState(history.state,'',location.pathname+location.search);
  for(const open of document.querySelectorAll('dialog.radio-dialog[open]'))open.close();
  openRadio({...options,schedule:'/radio/stations/'+link[1]+'/now',headers:{'X-Mirea-Radio-Share':link[2]}});
  return true;
}

export function openStationDirectory(options) {
  const {dialog,api,sessionRevision,fmCapabilities}=options;
  const node=dialog('ラジオ局',`<div class="radio-player">
    <p>局を選んで聴く、または自分の音声プレイリストから局を作れます。再生には、局の公開範囲に加えて全曲の本棚へのアクセス権が必要です。</p>
    <div class="radio-directory-tools">
      <label>局名で絞り込む <input type="search" data-radio="search" placeholder="ラジオ局を検索"></label>
      <button type="button" data-radio="owned" class="button secondary" aria-pressed="false">自分の局のみ</button>
    </div>
    <div class="media-grid radio-station-grid" data-radio="stations" aria-label="ラジオ局一覧"></div>
    <p data-radio="empty" class="muted" hidden>条件に合う局はありません。</p>
    <div class="radio-station-actions">
      <button type="button" data-radio="listen" class="button primary">この局を聴く</button>
      <button type="button" data-radio="pilot" class="button secondary" hidden>試験局を聴く</button>
      <button type="button" data-radio="more" class="button secondary" hidden>さらに表示</button>
      <button type="button" data-radio="edit" class="button secondary">局を編集</button>
      <button type="button" data-radio="new" class="button secondary">局を作る</button>
    </div>
    <form class="radio-station-form" hidden>
      <label>局名 <input name="stationName" required maxlength="120"></label>
      <label>音声プレイリスト <select name="playlist" required></select></label>
      <button type="button" data-radio="tracks" class="button secondary">曲を選ぶ</button>
      <label>公開範囲 <select name="visibility">
        <option value="private">非公開：自分のみ</option>
        <option value="unlisted">限定公開：リンクを知っているログイン済みユーザー</option>
        <option value="public">公開：ログイン済みユーザーの局一覧に表示</option>
      </select></label>
      <fieldset data-radio="autodj" hidden disabled>
        <legend>AutoDJ</legend>
        <label>曲順 <select name="autodjMode"><option value="ordered">リスト順</option><option value="shuffle">シャッフル（全員共通）</option></select></label>
        <div data-radio="autodj-sources"></div>
        <button type="button" data-radio="autodj-add" class="button secondary">再生元を追加</button>
        <small>優先順に最大5個（メイン＋追加4個）。同じ曲は一度だけ流れます。</small>
      </fieldset>
      <fieldset data-radio="fm" hidden>
        <legend>FM演出</legend>
        <label>MCの仕上がり <select name="mc"><option value="off">なし</option><option value="standard">標準</option><option value="enhanced">こだわり</option></select></label>
        <button type="button" data-radio="preview-mc" class="button secondary">MCを試聴</button>
        <label>ジングルの仕上がり <select name="jingle"><option value="off">なし</option><option value="standard">標準</option><option value="enhanced">こだわり</option></select></label>
        <button type="button" data-radio="preview-jingle" class="button secondary">ジングルを試聴</button>
        <audio data-radio="fm-sample" preload="none" controls hidden></audio>
        <small>${options.dynamicMc?'MCは原則2曲に1回、放送前に準備します。間に合わなければそのまま次の曲へ進みます。':'音源が準備されていない演出は挟まず、次の曲を流します。'}仕上がりを変更すると局の番組が先頭から始まります。</small>
      </fieldset>
      <label data-radio="crossfade" hidden><span><input type="checkbox" name="crossfade"> 曲のつなぎをクロスフェード（2.4秒）</span><small>曲同士のみ。曲間の自動MC・ジングルを優先し、短すぎる曲や周回のつなぎは重ねません。</small></label>
      <p>局名と番組内の曲名は、公開範囲と本棚の権限に応じて他の利用者に表示されます。</p>
      <div class="radio-station-actions">
        <button type="submit" class="button primary">保存</button>
        <button type="button" data-radio="rotate" class="button secondary" hidden>共有リンクを新しくする</button>
        <button type="button" data-radio="delete" class="button danger" hidden>局を削除</button>
        <button type="button" data-radio="cancel" class="button secondary">閉じる</button>
      </div>
    </form>
    <label data-radio="link" hidden>限定公開リンク（保存・再発行したときだけ表示）
      <input type="text" readonly>
      <button type="button" data-radio="copy" class="button secondary">リンクをコピー</button>
    </label>
    <p role="status" data-radio="status"></p>
  </div>`,'radio-dialog radio-directory');
  const action=name=>node.querySelector('[data-radio="'+name+'"]');
  const cards=action('stations'),search=action('search'),owned=action('owned'),form=node.querySelector('form');
  const playlist=form.elements.playlist,name=form.elements.stationName,visibility=form.elements.visibility;
  const output=action('link'),linkField=output.querySelector('input'),status=action('status');
  const control=new AbortController(),revision=sessionRevision();
  const sample=action('fm-sample');
  let sampleUrl,sampleAbort;
  function clearSample(){
    sampleAbort?.abort();sampleAbort=null;
    sample.pause();sample.removeAttribute('src');sample.load();sample.hidden=true;
    if(sampleUrl){URL.revokeObjectURL(sampleUrl);sampleUrl=null;}
  }
  action('fm').hidden=!fmCapabilities;
  action('crossfade').hidden=options.crossfadeCapable!==true;
  for(const kind of ['mc','jingle']){
    const choices=form.elements[kind];
    for(const option of choices.options){
      if(option.value!=='off'&&!fmCapabilities?.[kind]?.includes(option.value))option.textContent+=(kind==='mc'&&options.dynamicMc)?'（放送前に生成）':'（音源準備中）';
    }
    choices.onchange=()=>{clearSample();sync();};
    action('preview-'+kind).onclick=async()=>{
      if(!fmCapabilities?.[kind]?.includes(choices.value))return;
      clearSample();
      const ctrl=new AbortController();sampleAbort=ctrl;
      try{
        const blob=await options.authenticatedBlob('/api/v1/radio/fm/preview/'+kind+'-'+choices.value,AbortSignal.any([ctrl.signal,control.signal]));
        if(!current()||ctrl.signal.aborted)return;
        sampleUrl=URL.createObjectURL(blob);sample.src=sampleUrl;sample.hidden=false;
        await sample.play();
      }catch(error){
        if(current()&&!ctrl.signal.aborted)status.textContent=error.name==='NotAllowedError'?'試聴プレーヤーの再生ボタンを押してください。':'試聴音源を読み込めませんでした。';
      }
    };
  }
  const current=()=>node.open&&!control.signal.aborted&&revision===sessionRevision();
  const dismiss=()=>node.close();
  window.addEventListener('mirea:unauthorized',dismiss);
  node.addEventListener('close',()=>{control.abort();clearSample();linkField.value='';window.removeEventListener('mirea:unauthorized',dismiss);},{once:true});
  const request=(path,init)=>api(path,{...init,signal:control.signal,diagnostics:false});
  let stations=[],next=null,editing=null,busy=false,trackDialog,selectedId='',ownOnly=false;
  let sources=[],usablePlaylists=[],autoAvailable=options.autodj===true,autoTouched=false;
  node.addEventListener('close',()=>trackDialog?.close(),{once:true});
  const selected=()=>stations.find(station=>station.id===selectedId);
  const visibleStations=()=>stations.filter(s=>!ownOnly||s.mine)
    .filter(s=>s.name.normalize('NFKC').toLocaleLowerCase().includes(search.value.trim().normalize('NFKC').toLocaleLowerCase()));
  function renderSources(){
    const host=action('autodj-sources');
    host.replaceChildren(...sources.map((id,index)=>{
      const row=document.createElement('div');row.className='radio-autodj-source';
      const label=document.createElement('label');label.textContent='追加元 '+(index+1);
      const choice=document.createElement('select');choice.required=true;
      choice.replaceChildren(new Option('プレイリストを選ぶ',''),...usablePlaylists.filter(p=>
        p.id===id||(p.id!==playlist.value&&!sources.includes(p.id))).map(p=>new Option(p.title,p.id)));
      if(id&&!usablePlaylists.some(p=>p.id===id))choice.add(new Option('現在使用できないプレイリスト',id));
      choice.value=id;choice.disabled=busy;
      choice.onchange=()=>{sources[index]=choice.value;autoTouched=true;renderSources();host.children[index]?.querySelector('select')?.focus();};
      label.append(choice);
      const remove=document.createElement('button');remove.type='button';remove.className='button secondary';
      remove.textContent='外す';remove.setAttribute('aria-label','追加元 '+(index+1)+' を外す');remove.disabled=busy;
      remove.onclick=()=>{sources.splice(index,1);autoTouched=true;renderSources();action('autodj-add').focus();};
      const controls=document.createElement('div');controls.className='radio-autodj-order';
      function move(delta){
        const other=index+delta;
        if(other<0||other>=sources.length)return;
        [sources[other],sources[index]]=[sources[index],sources[other]];
        autoTouched=true;renderSources();host.children[other]?.querySelector('select')?.focus();
      }
      for(const [delta,text] of [[-1,'前へ'],[1,'後へ']]){
        const arrow=document.createElement('button');arrow.type='button';arrow.className='button secondary';
        arrow.textContent=text;arrow.setAttribute('aria-label','追加元 '+(index+1)+' を'+text);
        arrow.dataset.orderEdge=String(index+delta<0||index+delta>=sources.length);
        arrow.disabled=busy||arrow.dataset.orderEdge==='true';arrow.onclick=()=>move(delta);controls.append(arrow);
      }
      controls.append(remove);row.append(label,controls);return row;
    }));
    action('autodj-add').disabled=busy||sources.length>=4||
      !usablePlaylists.some(p=>p.id!==playlist.value&&!sources.includes(p.id));
  }
  function resetForm(){clearSample();editing=null;form.hidden=true;output.hidden=true;linkField.value='';}
  function sync(){
    action('listen').disabled=busy||!selected();
    action('edit').disabled=busy||!selected()?.mine;
    action('new').disabled=busy;
    action('more').hidden=!next;
    action('more').disabled=busy;
    cards.querySelectorAll('button').forEach(button=>{button.disabled=busy;});
    search.disabled=busy;owned.disabled=busy;
    for(const element of form.elements)element.disabled=busy;
    for(const kind of ['mc','jingle'])action('preview-'+kind).disabled=busy||!fmCapabilities?.[kind]?.includes(form.elements[kind].value);
    action('autodj').hidden=!autoAvailable;
    action('autodj').disabled=busy||!autoAvailable;
    for(const button of action('autodj-sources').querySelectorAll('select,button'))button.disabled=busy||button.dataset.orderEdge==='true';
    action('autodj-add').disabled=busy||sources.length>=4||
      !usablePlaylists.some(p=>p.id!==playlist.value&&!sources.includes(p.id));
  }
  function populate(id){
    const visible=visibleStations();
    selectedId=visible.some(station=>station.id===(id??selectedId))?(id??selectedId):(visible[0]?.id??'');
    const used=cards.contains(document.activeElement)?document.activeElement.dataset.station:null;
    cards.replaceChildren(...visible.map(station=>{
      const card=document.createElement('article');card.className='media-card radio-station-card';
      const button=document.createElement('button');button.type='button';button.className='card-open';
      button.dataset.station=station.id;button.setAttribute('aria-pressed',String(station.id===selectedId));
      button.setAttribute('aria-label',station.name+'（'+labels[station.visibility]+(station.mine?'・自分の局':'')+'）');
      button.innerHTML='<div class="card-art audio-cover radio-station-art"><span class="radio-station-glyph">'+playerIcon('volume')+'</span><span class="media-type">RADIO</span></div><div class="card-content"><h3></h3><div class="card-meta"><span></span></div></div>';
      button.querySelector('h3').textContent=station.name;
      button.querySelector('.card-meta span').textContent=labels[station.visibility]+(station.mine?' • 自分の局':'');
      button.onclick=()=>{selectedId=station.id;resetForm();populate(station.id);};
      card.append(button);return card;
    }));
    if(used)Array.from(cards.querySelectorAll('button')).find(button=>button.dataset.station===used)?.focus();
    action('empty').hidden=!stations.length||visible.length!==0;
    sync();
  }
  async function list(id,append=false){
    const result=await request('/radio/stations'+(append&&next?'?after='+next:''));
    if(!current())return;
    stations=append?[...new Map([...stations,...result.stations].map(station=>[station.id,station])).values()]:result.stations;
    next=result.next;autoAvailable=options.autodj===true||stations.some(station=>station.mine&&station.autodj);
    populate(id);
    status.textContent=stations.length?'':'表示できる局はまだありません。';
  }
  function run(work){
    if(busy||!current())return;
    busy=true;status.textContent='';sync();
    void (async()=>{try{await work();}catch(error){if(current())status.textContent=error.message||'操作できませんでした。';}
      finally{busy=false;if(current())sync();}})();
  }
  async function edit(station){
    resetForm();
    const {playlists}=await request('/playlists');
    if(!current())return;
    const usable=playlists.filter(item=>item.kind==='audio'&&!item.mixed);
    playlist.replaceChildren(new Option('プレイリストを選択',''),...usable.map(item=>new Option(item.title,item.id)));
    if(!usable.length)status.textContent='「曲を選ぶ」から、ラジオ用のプレイリストを作れます。';
    editing=station;usablePlaylists=usable;autoTouched=false;
    sources=(station?.autodj?.playlistIds??[]).slice(1);
    form.elements.autodjMode.value=station?.autodj?.mode??'ordered';
    name.value=station?.name??'';playlist.value=usable.some(item=>item.id===station?.playlistId)?station.playlistId:'';
    visibility.value=station?.visibility??'private';renderSources();
    form.elements.crossfade.checked=station?.crossfadeMs===2400;
    for(const kind of ['mc','jingle'])form.elements[kind].value=station?.fm?.[kind]??'off';
    action('rotate').hidden=station?.visibility!=='unlisted';
    action('delete').hidden=!station;
    form.hidden=false;
  }
  function displayLink(station,share){
    if(!share)return;
    const url=new URL(location.pathname,location.origin);
    url.hash='mirea-radio='+station.id+'.'+share;
    linkField.value=url.href;output.hidden=false;
  }
  search.oninput=()=>{resetForm();populate();};
  owned.onclick=()=>{ownOnly=!ownOnly;owned.setAttribute('aria-pressed',String(ownOnly));resetForm();populate();};
  playlist.onchange=()=>{sources=sources.filter(id=>id!==playlist.value);autoTouched=true;renderSources();};
  form.elements.autodjMode.onchange=()=>{autoTouched=true;};
  action('autodj-add').onclick=()=>{if(sources.length>=4)return;sources.push('');autoTouched=true;renderSources();action('autodj-sources').lastElementChild?.querySelector('select')?.focus();};
  function openSelected(){
    const station=selected();
    if(!station)return;
    node.close();openRadio({...options,stationName:station.name,schedule:'/radio/stations/'+station.id+'/now',onDirectory:()=>openStationDirectory(options)});
  }
  action('listen').onclick=openSelected;
  action('pilot').hidden=!options.pilotAvailable;
  action('pilot').onclick=()=>{node.close();openRadio(options);};
  action('more').onclick=()=>run(()=>list(selectedId,true));
  action('edit').onclick=()=>run(()=>edit(selected()));
  action('new').onclick=()=>run(()=>edit(null));
  action('cancel').onclick=resetForm;
  action('tracks').onclick=()=>{
    if(busy||trackDialog?.open||!current())return;
    clearSample();
    trackDialog=openRadioTrackPicker({...options,name:name.value,source:playlist.value,currentParent:current,onSaved:saved=>{
      if(!current())return;
      playlist.add(new Option(saved.title,saved.id,false,true));
      usablePlaylists=[...usablePlaylists,{id:saved.id,title:saved.title}];playlist.onchange();
      status.textContent='曲の並び順を保存しました。局の設定を保存すると反映されます。';
    }});
  };
  form.onsubmit=event=>{event.preventDefault();run(async()=>{
    const auto=autoAvailable&&(!editing||autoTouched)?{autodj:{mode:form.elements.autodjMode.value,playlistIds:[playlist.value,...sources]}}:{};
    const transition=options.crossfadeCapable===true?{crossfadeMs:form.elements.crossfade.checked?2400:0}:{};
    const payload={...auto,...transition,name:name.value,playlistId:playlist.value,visibility:visibility.value,...(fmCapabilities?{fm:{mc:form.elements.mc.value,jingle:form.elements.jingle.value}}:{}),...(editing?{revision:editing.revision}:{})};
    const {station,share}=await request('/radio/stations'+(editing?'/'+editing.id:''),{method:editing?'PUT':'POST',body:payload});
    if(!current())return;
    resetForm();await list(station.id);
    if(current()){displayLink(station,share);status.textContent='保存しました。';}
  });};
  action('rotate').onclick=()=>{if(!editing||!confirm('古い共有リンクは使えなくなります。新しくしますか？'))return;
    run(async()=>{
      const {station,share}=await request('/radio/stations/'+editing.id+'/rotate-link',{method:'POST',body:{revision:editing.revision}});
      if(!current())return;
      resetForm();await list(station.id);
      if(current()){displayLink(station,share);status.textContent='リンクを更新しました。';}
    });
  };
  action('delete').onclick=()=>{if(!editing||!confirm('このラジオ局を削除しますか？ 元のプレイリストは残ります。'))return;
    run(async()=>{
      await request('/radio/stations/'+editing.id,{method:'DELETE',body:{revision:editing.revision}});
      if(!current())return;
      resetForm();await list();
      if(current())status.textContent='ラジオ局を削除しました。';
    });
  };
  action('copy').onclick=async()=>{
    try{await navigator.clipboard.writeText(linkField.value);if(current())status.textContent='リンクをコピーしました。';}
    catch{if(current()){linkField.select();status.textContent='選択したリンクをコピーしてください。';}}
  };
  run(()=>list());
  return node;
}
