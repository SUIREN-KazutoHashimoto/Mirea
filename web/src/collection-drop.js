export function mountCollectionDrop({root,onFiles,allowed=()=>true,doc=root.ownerDocument}){
  let depth=0;const hint=doc.createElement('div');hint.className='collection-drop-hint';hint.hidden=true;hint.textContent='ここにドロップして追加内容を確認します（送信はまだ開始しません）';doc.body.append(hint);
  const files=event=>Array.from(event.dataTransfer?.types??[]).includes('Files');
  const clear=()=>{depth=0;hint.hidden=true;root.classList.remove('collection-drop-target');};
  const enter=event=>{if(!files(event)||!allowed()||doc.querySelector('dialog[open],.viewer-screen'))return;event.preventDefault();depth++;hint.hidden=false;root.classList.add('collection-drop-target');};
  const over=event=>{if(files(event)&&allowed()&&!doc.querySelector('dialog[open],.viewer-screen')){event.preventDefault();event.dataTransfer.dropEffect='copy';}};
  const leave=()=>{if(--depth<=0)clear();};
  const drop=event=>{if(!files(event))return;event.preventDefault();const selected=Array.from(event.dataTransfer.files??[]);clear();if(selected.length&&allowed()&&!doc.querySelector('dialog[open],.viewer-screen'))onFiles(selected);};
  root.addEventListener('dragenter',enter);root.addEventListener('dragover',over);root.addEventListener('dragleave',leave);root.addEventListener('drop',drop);doc.defaultView.addEventListener('blur',clear);
  return ()=>{clear();hint.remove();root.removeEventListener('dragenter',enter);root.removeEventListener('dragover',over);root.removeEventListener('dragleave',leave);root.removeEventListener('drop',drop);doc.defaultView.removeEventListener('blur',clear);};
}
