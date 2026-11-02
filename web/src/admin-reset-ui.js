export async function mountAdminReset({panel,api,esc,bytes,confirm,valid,onReset}){
  const state=await api('/admin/reset');if(!valid())return;
  panel.innerHTML=`<h3>メタデータ・アセットのリセット</h3><p class="admin-warning">全ユーザーの本棚・共有設定・シリーズ・アセット・サムネイル・アップロード・ジョブ・閲覧記録・統計・続き位置・ダウンロード登録を全削除します。元に戻せません。先に「バックアップ」で全体バックアップを取得してください。</p><p>アカウント（メール・名前・パスワード・サーバー権限・停止状態）、ログイン状態、サーバー設定、暗号鍵、証明書、バックアップ、更新設定、管理操作の記録は残します。</p><p class="muted">端末に保存されたファイルは遠隔削除できません。既存のオフライン視聴許可は最長7日残る場合があります。オンライン再接続時には削除済みアセットの権限を失います。リセットでは保存領域の権限不足・容量不足は直りません。</p><p>保持するアカウント: ${state.accounts}件</p><button class="button danger reset-preview" ${state.pending?'hidden':''}>全削除する対象を確認</button><button class="button danger reset-recover" ${state.pending?'':'hidden'}>未完了の後処理を再試行</button><p class="admin-status" role="status"></p>`;
  const fail=error=>{if(valid())panel.querySelector('.admin-status').textContent=error.message;};
  panel.querySelector('.reset-preview').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{
      const plan=await api('/admin/reset/preview',{method:'POST'});if(!valid())return;
      confirm('全メタデータ・アセットを削除',`本棚 ${plan.shelves}件、シリーズ ${plan.series}件、アセット ${plan.assets}件、アップロード ${plan.uploads}件、閲覧セッション ${plan.views}件、ファイル ${plan.files}個（${bytes(plan.bytes)}）を削除します。${plan.accounts}アカウントは保持します。`,
        `<label class="confirm-row"><input name="backup" type="checkbox" required>必要な全体バックアップを取得・保管済みです</label><label class="confirm-row"><input name="offline" type="checkbox" required>端末内のオフラインデータを遠隔削除できないことを理解しました</label><label>確認のため ${esc(state.confirmation)} と入力<input name="confirmText" autocomplete="off" required pattern="${esc(state.confirmation)}"></label>`,async values=>{
          const result=await api('/admin/reset/apply',{method:'POST',body:{previewId:plan.previewId,confirmText:values.confirmText,currentPassword:values.currentPassword,acknowledgeBackup:values.backup==='on',acknowledgeOffline:values.offline==='on'}});
          if(result.complete)await onReset?.();return result;
        });
    }catch(error){fail(error);}finally{if(valid())button.disabled=false;}
  };
  panel.querySelector('.reset-recover').onclick=()=>confirm('リセットの後処理を再試行','前回の処理を復旧します。新しいリセットは開始しません。',`<label>確認のため ${esc(state.confirmation)} と入力<input name="confirmText" required pattern="${esc(state.confirmation)}"></label>`,async values=>{const result=await api('/admin/reset/recover',{method:'POST',body:{currentPassword:values.currentPassword,confirmText:values.confirmText}});await onReset?.();return result;});
}
