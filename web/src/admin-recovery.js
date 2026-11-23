const date=value=>value?new Date(value).toLocaleString():'未取得';
const reason=value=>({scheduled:'定期',manual:'手動', 'pre-upgrade':'更新前'})[value]??'保全';
export async function mountRecovery({panel,api,valid,esc,bytes,status,confirm}){
 panel.innerHTML=`<h3>自動保全・復旧</h3><p>DB・暗号鍵・設定・保存先の識別情報を短い間隔で保存します。作品本体・表紙・AIモデルはコピーしません。これらはホスト側のバックアップで保管してください。</p>
 <p class="admin-warning">同じ保存装置内の保全だけでは、装置の故障や紛失には備えられません。保全フォルダー全体を別媒体にも複製してください。自動保全は平文の機密データを含みます。</p>
 <div class="recovery-health" aria-live="polite"></div><p class="admin-status" role="status"></p>
 <div class="admin-actions"><button class="button secondary recovery-refresh">状況を更新</button><button class="button primary recovery-database">メタデータを今すぐ保全</button></div>
 <details class="manager-note"><summary>保存間隔と保持期間</summary><form class="recovery-settings">
 <label>DB・鍵の保全間隔（分）<input name="intervalMinutes" type="number" min="1" max="1440" required></label>
 <label>定期復旧点の保持期間（日）<input name="retentionDays" type="number" min="7" max="365" required></label>
 <label>確保する空き容量（MiB）<input name="reserveMiB" type="number" min="64" max="1048576" required></label>
 <label>自動保全の容量上限（MiB）<input name="automaticBudgetMiB" type="number" min="64" max="1048576"></label>
 <p class="muted">直近24時間を細かく、7日までは1時間ごと、それ以前は1日ごとに残します。更新前・手動の復旧点と最新2件は、自動削除しません。</p><p class="recovery-ignored muted"></p>
 <label>現在の管理者パスワード<input name="currentPassword" type="password" autocomplete="current-password" required></label><button class="button primary">設定を保存</button></form></details>
 <details class="manager-note"><summary>障害時に戻す手順</summary><ol><li>Mireaを停止し、問題が起きた保存領域も残します。</li><li>復旧点の「検証」でチェックサムとDBの整合性を確認します。</li><li>同梱の recover-data.mjs に --metadata-only を指定し、元データとは別の空の作業先へ取り出します。</li><li>対応する作品本体・表紙等のホスト側バックアップと組み合わせます。メタデータだけで作品本体は戻りません。</li><li>更新前に戻す場合は対応する旧版と設定も使い、アカウント・作品・続き位置を確認します。</li></ol><p>旧版が作成した全体復旧点の検証・復元も利用できます。コードの版だけを戻して新しいDBを開く操作は行いません。</p><p>詳細なコマンドは配布物の docs/operations/recovery.md にあります。</p></details>
 <h4>復旧点（最新100件）</h4><div class="recovery-list"></div>`;
 let disposed=false,loading=false,initialized=false,signature='';
 const current=()=>!disposed&&valid();
 const form=panel.querySelector('.recovery-settings');
 async function load(){if(loading||!current())return;loading=true;try{
  const data=await api('/admin/recovery');if(!current())return;
  const health=panel.querySelector('.recovery-health'),problem=data.lastError||data.databaseOverdue;
  health.className='recovery-health '+(problem?'admin-warning':'admin-card');
  health.innerHTML=`<dl class="recovery-facts"><div><dt>メタデータの最終保全</dt><dd>${esc(date(data.lastDatabaseAt))}</dd></div><div><dt>作品本体の保全</dt><dd>ホスト側で管理</dd></div><div><dt>状態</dt><dd>${data.active?`実行中：${data.active.scope==='verify'?'復旧点を検証':'メタデータを保全'}${data.progress?` · ${data.progress.files}ファイル · ${bytes(data.progress.bytes)}`:''}`:data.lastError?'保全に失敗しました。保存先の容量・接続・権限を確認してください。':'待機中'}</dd></div></dl>${data.lastError?`<p>確認用コード：${esc(data.lastError.code)} · ${esc(date(data.lastError.at))}</p>`:''}${data.nextScheduledAttemptAt>Date.now()?'<p>次の自動試行：'+esc(date(data.nextScheduledAttemptAt))+'</p>':''}<details><summary>保全の保存先</summary><code class="recovery-directory">${esc(data.directory)}</code><p>RECOVERY_DIRで専用の保存領域を指定できます。別媒体へは、このフォルダー全体を複製してください。一部のファイルだけでは復旧できません。</p></details>`;
  panel.querySelector('.recovery-database').disabled=Boolean(data.active);
  if(!initialized){for(const [key,value]of Object.entries(data.settings.applied)){const input=form.elements[key],override=data.settings.overrides[key];if(!input)continue;input.value=value;if(override){input.disabled=true;const note=document.createElement('small');note.textContent=`${override.variable} = ${override.value} で上書き中`;input.closest('label').append(note);}}panel.querySelector('.recovery-ignored').textContent=(data.settings.ignored??[]).map(row=>`${row.variable??row.setting} = ${row.value} は旧版の全体保全用設定です。現在は使用しません。`).join(' ');initialized=true;}
  const next=JSON.stringify([data.snapshots,data.active,data.lastVerified]);if(signature===next)return;signature=next;
  const list=panel.querySelector('.recovery-list');list.innerHTML=data.snapshots.length?data.snapshots.map(row=>`<article class="admin-card"><strong>${row.invalid?'検査が必要な復旧点':`${row.scope==='full'?'旧版の全体保全':'メタデータ'} · ${reason(row.reason)} · ${esc(date(row.createdAt))}`}</strong><small>${esc(row.id)}</small>${row.invalid?'<p>復旧点の情報を読み込めません。削除せず、保存先とバックアップの状態を確認してください。</p>':`<p>${row.files}ファイル · ${bytes(row.bytes)} · ${row.database.assets}アセット</p><small>${row.reason==='pre-upgrade'?`更新前の版：${esc(row.previousVersion??'未記録')} · `:''}作成した版：${esc(row.version)}${['manual','pre-upgrade'].includes(row.reason)?' · 自動削除の対象外':''}</small><button class="button secondary" data-verify-recovery="${esc(row.id)}" ${data.active?'disabled':''}>復旧点を検証</button>${data.lastVerified?.id===row.id?`<p>検証済み：${esc(date(data.lastVerified.at))}</p>`:''}`}</article>`).join(''):'<p>復旧点はまだありません。最初の定期保全を待つか、「メタデータを今すぐ保全」を実行してください。</p>';
  for(const button of list.querySelectorAll('[data-verify-recovery]'))button.onclick=()=>confirm('復旧点を検証','保存されたファイルのチェックサムとDBの整合性を検査します。データ量に応じて時間がかかります。','',values=>api('/admin/recovery/'+button.dataset.verifyRecovery+'/verify',{method:'POST',body:{currentPassword:values.currentPassword}}));
 }catch(error){if(current())status(error);}finally{loading=false;}}
 panel.querySelector('.recovery-refresh').onclick=()=>load();
 panel.querySelector('.recovery-database').onclick=()=>confirm('メタデータを保全','作品の利用を継続しながらDB・設定・暗号鍵・保存先情報を保存します。作品本体・表紙・AIモデルは含みません。','',values=>api('/admin/recovery',{method:'POST',body:{scope:'database',acknowledgePause:false,currentPassword:values.currentPassword}}));
 form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const values=Object.fromEntries(['intervalMinutes','retentionDays','reserveMiB','automaticBudgetMiB'].filter(key=>!form.elements[key].disabled&&form.elements[key].value!=='').map(key=>[key,Number(form.elements[key].value)]));await api('/admin/recovery/settings',{method:'PATCH',body:{values,currentPassword:form.elements.currentPassword.value}});if(current())status('保存しました。次の保全から適用します。');}catch(error){if(current())status(error);}finally{form.elements.currentPassword.value='';button.disabled=false;}};
 await load();const timer=setInterval(()=>load(),5000);return ()=>{disposed=true;clearInterval(timer);};
}
