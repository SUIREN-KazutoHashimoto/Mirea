export function showShelfMenu({shelf,dialog,api,esc,renameDone,deleteDone,share,statistics,isCurrent}){
  const owner=shelf.role==='owner';
  const node=dialog(`${shelf.name} の本棚メニュー`,`<div class="modal-body shelf-menu"><p class="muted">${owner?'この本棚の所有者です。名前・共有・削除を管理できます。':'この本棚の名前変更・削除・共有設定は所有者だけが行えます。'}</p>${owner?'<button class="button secondary shelf-rename">本棚の名前を変更</button><button class="button secondary shelf-share">共有設定</button><button class="button secondary shelf-statistics">本棚の匿名集計</button><button class="button danger shelf-delete">本棚を削除</button>':''}</div>`);
  if(!owner)return;
  node.querySelector('.shelf-share').onclick=()=>{node.close();if(isCurrent())share(shelf.id);};
  node.querySelector('.shelf-statistics').onclick=()=>{node.close();if(isCurrent())statistics(shelf.id);};
  node.querySelector('.shelf-rename').onclick=()=>{
    node.close();if(!isCurrent())return;
    const rename=dialog('本棚の名前を変更',`<form class="modal-body"><label>本棚の名前<input name="name" maxlength="100" value="${esc(shelf.name)}" required></label><p class="muted">共有している全員に新しい名前が表示されます。</p><p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">名前を保存</button></form>`);
    const form=rename.querySelector('form');form.onsubmit=async e=>{e.preventDefault();if(!isCurrent()){rename.close();return;}const button=form.querySelector('button');button.disabled=true;try{await api('/shelves/'+shelf.id,{method:'PATCH',body:{name:form.elements.name.value.trim()}});rename.close();if(isCurrent())await renameDone();}catch(error){if(rename.isConnected){const box=form.querySelector('.form-error');box.textContent=error.message;box.hidden=false;button.disabled=false;}}};
  };
  node.querySelector('.shelf-delete').onclick=()=>{
    node.close();if(!isCurrent())return;
    const remove=dialog('本棚を削除',`<form class="modal-body"><p class="permission-note">「${esc(shelf.name)}」と中の全アセット・原本・配信データ・ダウンロード登録を削除します。共有している全員が利用できなくなります。端末内の暗号化ダウンロードも開けなくなります。この操作は元に戻せません。必要な場合は先に管理者へ全体バックアップを依頼してください。</p><label>確認のため本棚の名前を入力<input name="confirmName" maxlength="100" required autocomplete="off"></label><label>現在のパスワード<input name="currentPassword" type="password" maxlength="128" required autocomplete="current-password"></label><label class="confirm-row"><input name="confirmed" type="checkbox" required>本棚と中の全アセットを削除することを確認しました</label><p class="form-error" role="alert" hidden></p><button class="button danger" type="submit">本棚と全アセットを完全に削除</button></form>`);
    const form=remove.querySelector('form');form.onsubmit=async e=>{e.preventDefault();if(!isCurrent()){remove.close();return;}const button=form.querySelector('button');button.disabled=true;try{const result=await api('/shelves/'+shelf.id,{method:'DELETE',body:{confirmName:form.elements.confirmName.value,currentPassword:form.elements.currentPassword.value,acknowledgeDelete:true}});form.reset();remove.close();if(isCurrent())await deleteDone(shelf.id,result);}catch(error){if(remove.isConnected){form.elements.currentPassword.value='';const box=form.querySelector('.form-error');box.textContent=error.message;box.hidden=false;button.disabled=false;}}};
  };
}
