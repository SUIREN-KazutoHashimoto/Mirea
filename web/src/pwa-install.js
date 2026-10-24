// One install prompt per browser event. Never prompt automatically or store
// credentials/install markers; installation/removal belongs to the browser.
export function createPwaInstall({win=window,native=false,ensureWorker=async()=>{}}={}){
  const display=win.matchMedia?.('(display-mode: standalone)'),listeners=new Set();
  const supported=!native&&win.isSecureContext===true&&Boolean(win.navigator?.serviceWorker);
  let offered,pending=false,installed=Boolean(display?.matches||win.navigator?.standalone),notice='',preparing;
  const state=()=>({native,supported,installed,pending,available:Boolean(offered)&&!installed,notice});
  const emit=()=>{for(const fn of listeners)fn(state());};
  const onOffer=event=>{if(!supported||installed)return;event.preventDefault();offered=event;notice='';emit();};
  const onInstalled=()=>{installed=true;offered=null;notice='';emit();};
  const onDisplay=()=>{installed=Boolean(display?.matches||win.navigator?.standalone);emit();};
  win.addEventListener('beforeinstallprompt',onOffer);win.addEventListener('appinstalled',onInstalled);display?.addEventListener?.('change',onDisplay);
  async function prepare(){
    if(!supported||win.navigator.onLine===false)return;
    return preparing??=(async()=>{try{await Promise.resolve().then(ensureWorker);if(notice==='offline-shell')notice='';}catch{notice='offline-shell';}finally{preparing=null;emit();}})();
  }
  const onOnline=()=>{void prepare();};win.addEventListener('online',onOnline);
  return {
    state,prepare,
    subscribe(fn){listeners.add(fn);fn(state());return()=>listeners.delete(fn);},
    async install(){
      if(pending)return {outcome:'busy'};
      if(installed)return {outcome:'installed'};
      if(!supported||!offered)return {outcome:'manual'};
      const event=offered;offered=null;pending=true;notice='';emit();
      try{
        // prompt() must happen in this user gesture, before any other async work.
        const result=await event.prompt(),choice=await(event.userChoice??result);
        notice=installed?'':choice?.outcome==='accepted'?'accepted':'dismissed';
        return {outcome:choice?.outcome??'dismissed'};
      }catch{notice='failed';return {outcome:'failed'};}
      finally{pending=false;emit();}
    },
    dispose(){win.removeEventListener('beforeinstallprompt',onOffer);win.removeEventListener('appinstalled',onInstalled);win.removeEventListener('online',onOnline);display?.removeEventListener?.('change',onDisplay);listeners.clear();offered=null;}
  };
}

export function installPresentation(state){
  if(!state.supported)return {button:false,message:'PWAのインストールには対応ブラウザーと信頼されたHTTPSが必要です。LANでは端末にルートCAを信頼登録し、証明書の警告がないURLで開いてください。'};
  if(state.installed)return {button:false,message:'Mireaをアプリ画面で利用中です。保存済みの作品は、既存の7日間のオフライン視聴期限で利用できます。'};
  if(state.pending)return {button:true,disabled:true,label:'ブラウザーで確認してください',message:'インストールの確認画面を開いています。'};
  if(state.available)return {button:true,label:'Mireaをインストール',message:'ホーム画面やデスクトップから、ブラウザーのタブとは別のウィンドウで開けます。'};
  const prefix={accepted:'インストールを要求しました。完了するとアプリから起動できます。 ',dismissed:'インストールをキャンセルしました。 ',failed:'インストール画面を開けませんでした。 ','offline-shell':'オフライン画面を準備できませんでした。接続・証明書・ブラウザーの保存容量を確認してください。 '}[state.notice]??'';
  return {button:false,message:prefix+'PC／AndroidのChrome・Edgeはブラウザーのメニューから「アプリをインストール」。iPhone／iPadはSafariの共有メニューから「ホーム画面に追加」を選んでください。インストール項目の表示はブラウザーの判定によります。'};
}

export function mountPwaInstall(container,controller){
  if(!container||controller.state().native)return()=>{};
  container.classList.add('pwa-install');
  container.innerHTML='<button type="button" class="button secondary pwa-install-button" hidden>Mireaをインストール</button><p class="muted pwa-install-status" role="status"></p><small>APK版とは別のブラウザーアプリです。端末内の保存データが共有されるとは限りません。インストールだけで作品本体はダウンロードされません。</small>';
  const button=container.querySelector('button'),status=container.querySelector('[role="status"]');
  const unsubscribe=controller.subscribe(value=>{const view=installPresentation(value);button.hidden=!view.button;button.disabled=Boolean(view.disabled);button.textContent=view.label||'Mireaをインストール';status.textContent=view.message;});
  button.onclick=()=>{void controller.install();};
  return()=>{unsubscribe();button.onclick=null;};
}
