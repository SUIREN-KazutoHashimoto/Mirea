import {mountPlaylistEditor} from './playlist-ui.js';

const maxTrackBytes=16*1024*1024;
function stationSongs(catalog){
  // The ordinary catalog is permission-scoped. Its snapshot contains private
  // shelf metadata for the library, but radio must never show or queue it.
  const publicShelves=new Set(catalog.shelves.filter(shelf=>!shelf.private).map(shelf=>shelf.id));
  return catalog.items.filter(item=>{
    const duration=item.mediaInfo?.duration;
    return publicShelves.has(item.shelfId)&&!item.pending&&!item.originalPlayback&&item.kind==='audio'&&
      item.mimeType==='audio/mp4'&&item.size>0&&item.size<=maxTrackBytes&&
      (duration===undefined||(Number.isFinite(duration)&&duration>=1&&duration<=600));
  });
}

export function openRadioTrackPicker({dialog,api,sessionRevision,renderSongCard,loadThumbnails,esc,
  name,source,onSaved,currentParent}){
  const node=dialog('曲を選ぶ','<div class="radio-track-picker-body"><p role="status">コンテンツ一覧を読み込んでいます…</p><div class="radio-track-editor"></div></div>','radio-dialog radio-track-picker');
  const status=node.querySelector('[role=status]'),host=node.querySelector('.radio-track-editor');
  const controller=new AbortController(), revision=sessionRevision();
  const current=()=>node.open&&!controller.signal.aborted&&revision===sessionRevision()&&currentParent();
  const request=(path,options)=>api(path,{...options,signal:controller.signal,diagnostics:false});
  const close=()=>node.close();
  window.addEventListener('mirea:unauthorized',close);
  node.addEventListener('close',()=>{
    controller.abort();loadThumbnails();window.removeEventListener('mirea:unauthorized',close);
  },{once:true});
  void(async()=>{
    try{
      const catalog=await request('/library/catalog');
      if(!current())return;
      const items=stationSongs(catalog);
      if(!items.length){status.textContent='ラジオに使える曲がありません。非公開でない本棚に変換済みの音声を追加してください。';return;}
      const prior=catalog.playlists.find(p=>p.id===source), ids=new Set(items.map(item=>item.id));
      const copied=(prior?.assetIds??[]).filter(id=>ids.has(id));
      status.textContent=prior?'元のプレイリストを変更せず、新しいリストに保存します。':'選んだ曲を、自分専用の新しいプレイリストとして保存します。';
      if(prior&&copied.length!==(prior.assetIds?.length??0))status.textContent+=' ラジオに使えない曲はコピーしません。';
      if(copied.length>200)status.textContent+=' 200曲を超えるため、元のリストはコピーせずに選択画面を開きます。';
      const draft={title:(name.trim()||prior?.title||'ラジオ')+'（ラジオ用）',assetIds:copied.length<=200?copied:[]};
      mountPlaylistEditor({container:host,draft,items,api:request,esc,current,onCancel:close,
        trackPicker:{renderSongCard,loadThumbnails},onChanged:async saved=>{
          if(!current())return;
          onSaved(saved);close();
        }});
    }catch(error){if(current())status.textContent=error.message||'曲を読み込めませんでした。';}
  })();
  return node;
}
