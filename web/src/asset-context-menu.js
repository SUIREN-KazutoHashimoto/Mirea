let disposeCurrent;
// A small non-modal menu. It never locks/inerts the library or adds a backdrop.
export function openAssetContextMenu({title,actions,position,anchor,doc=document}){
  disposeCurrent?.();const menu=doc.createElement('div'),previous=doc.activeElement;
  menu.className='asset-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',title);
  const close=({restore=false}={})=>{doc.removeEventListener('pointerdown',outside,true);doc.removeEventListener('keydown',keydown,true);doc.defaultView.removeEventListener('resize',close);menu.remove();if(disposeCurrent===close)disposeCurrent=null;if(restore&&previous?.isConnected)previous.focus({preventScroll:true});};
  const buttons=[];
  for(const action of actions){const button=doc.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=action.label;button.disabled=Boolean(action.disabled);if(action.danger)button.className='danger-text';button.onclick=()=>{close();action.run();};menu.append(button);if(!button.disabled)buttons.push(button);}
  function outside(event){if(!menu.contains(event.target))close();}
  function keydown(event){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close({restore:true});return;}if(!['ArrowDown','ArrowUp','Home','End','Tab'].includes(event.key))return;event.preventDefault();if(event.key==='Tab'){close({restore:true});return;}const index=buttons.indexOf(doc.activeElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length;buttons[next]?.focus();}
  doc.body.append(menu);const rect=anchor?.getBoundingClientRect(),box=menu.getBoundingClientRect(),x=position?.x??rect?.left??12,y=position?.y??rect?.bottom??12;
  menu.style.left=Math.max(8,Math.min(x,doc.documentElement.clientWidth-box.width-8))+'px';menu.style.top=Math.max(8,Math.min(y,doc.defaultView.innerHeight-box.height-8))+'px';
  doc.addEventListener('pointerdown',outside,true);doc.addEventListener('keydown',keydown,true);doc.defaultView.addEventListener('resize',close,{once:true});disposeCurrent=close;buttons[0]?.focus({preventScroll:true});return {close,node:menu};
}
