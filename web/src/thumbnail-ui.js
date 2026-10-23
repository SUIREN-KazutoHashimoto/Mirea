export function openThumbnailEditor({dialog,api,esc,items=[],seriesId,seriesTitle,isCurrent,onChanged,toast}){
  const candidates=items.filter(i=>!i.pending&&['owner','editor'].includes(i.role));
  const node=dialog('サムネイルを変更',`<form class="modal-body thumbnail-form"><p>${seriesId?'「'+esc(seriesTitle)+'」内の作品（子シリーズを含む）に同じ画像を設定します。':candidates.length===1?'「'+esc(candidates[0].title)+'」の画像を設定します。':'選んだ作品に同じ画像をまとめて設定します。'}</p><p class="muted">JPEG・PNG・WebPの静止画像、5MBまで。原本・動画プレビューは変更せず、再生成後もこの画像を優先します。</p><label>画像<input type="file" name="cover" accept="image/jpeg,image/png,image/webp" required></label><img class="thumbnail-preview" alt="新しいサムネイルのプレビュー" hidden>${!seriesId&&candidates.length>1?`<fieldset class="thumbnail-targets"><legend>変更する作品</legend><label><input type="checkbox" class="thumbnail-all" checked>すべて選択</label>${candidates.map(i=>`<label><input type="checkbox" name="asset" value="${esc(i.id)}" checked>${esc(i.title)}</label>`).join('')}</fieldset>`:''}<p class="form-error" role="alert" hidden></p><div class="modal-actions"><button type="button" class="button secondary thumbnail-reset">自動サムネイルに戻す</button><button type="submit" class="button primary">変更する</button></div></form>`,'thumbnail-modal');
  const form=node.querySelector('form'),file=form.elements.cover,preview=node.querySelector('img'),error=node.querySelector('.form-error');let url,busy=false;
  const target=()=>seriesId?{seriesId}:{assetIds:candidates.length===1?[candidates[0].id]:[...form.querySelectorAll('[name="asset"]:checked')].map(i=>i.value)};
  file.onchange=()=>{if(url)URL.revokeObjectURL(url);const image=file.files[0];preview.hidden=!image;if(image){url=URL.createObjectURL(image);preview.src=url;}};
  const all=node.querySelector('.thumbnail-all');if(all)all.onchange=()=>form.querySelectorAll('[name="asset"]').forEach(i=>{i.checked=all.checked;});
  node.addEventListener('close',()=>{if(url)URL.revokeObjectURL(url);},{once:true});
  async function apply(reset=false){
    if(busy||!isCurrent())return;
    const body=target();error.hidden=true;if(body.assetIds&&!body.assetIds.length){error.textContent='作品を選択してください。';error.hidden=false;return;}
    if(reset&&!confirm('選択した作品を自動生成サムネイルに戻しますか？'))return;
    busy=true;form.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{
      if(!reset){
        const image=file.files[0];if(!image||!['image/jpeg','image/png','image/webp'].includes(image.type)||image.size>5*1024*1024)throw Error('5MB以下のJPEG・PNG・WebPを選んでください。');
        const bytes=new Uint8Array(await image.arrayBuffer()),parts=[];for(let n=0;n<bytes.length;n+=8192)parts.push(String.fromCharCode(...bytes.subarray(n,n+8192)));
        body.image={mime:image.type,base64:btoa(parts.join(''))};
      }
      const result=await api('/thumbnails/custom',{method:reset?'DELETE':'POST',body});if(!isCurrent())return;
      node.close();await onChanged();toast(result.updated+'件のサムネイルを'+(reset?'自動生成に戻しました。':'変更しました。'));
    }catch(e){if(node.isConnected&&isCurrent()){error.textContent=e.message;error.hidden=false;}}
    finally{busy=false;if(node.isConnected)form.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }
  form.onsubmit=e=>{e.preventDefault();apply();};node.querySelector('.thumbnail-reset').onclick=()=>apply(true);return node;
}
