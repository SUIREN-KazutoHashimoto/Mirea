import {playlistKind} from '../../server/playlist-kind.js';
export function playlistContext(playlists,items,id,assetId){
 const playlist=playlists.find(p=>p.id===id),byId=new Map(items.map(item=>[item.id,item]));if(!playlist)throw Error('プレイリストを確認できません。');
 const members=playlist.assetIds.map((key,index)=>byId.has(key)?{...byId.get(key),series:{label:String(index+1)}}:null).filter(Boolean),kinds=new Set(members.map(playlistKind));
 if(kinds.size!==1||!['video','audio'].includes([...kinds][0]))throw Error('同じ種類の音声または動画のプレイリストを選んでください。');
 return {series:{id:playlist.id,title:playlist.title,playlist:true},items:members,currentIndex:members.findIndex(item=>item.id===assetId)};
}
