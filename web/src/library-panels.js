// Non-modal library controls: keep the collection usable and never shift it.
export function mountLibraryPanels({root,doc=root.ownerDocument,win=doc.defaultView}){
  let active,opener,positionFrame;const listeners=[];
  const listen=(node,type,handler,options)=>{node.addEventListener(type,handler,options);listeners.push(()=>node.removeEventListener(type,handler,options));};
  function close({focus=false}={}){if(positionFrame)win.cancelAnimationFrame(positionFrame);positionFrame=null;if(!active)return;active.hidden=true;opener?.setAttribute('aria-expanded','false');const target=opener;active=null;opener=null;if(focus&&target?.isConnected)target.focus({preventScroll:true});}
  function position(){if(!active||!opener?.isConnected){close();return;}const rect=opener.getBoundingClientRect(),box=active.getBoundingClientRect(),gap=8;if(rect.bottom<gap||rect.top>win.innerHeight-gap){close();return;}
    active.style.left=Math.max(gap,Math.min(rect.right-box.width,win.innerWidth-box.width-gap))+'px';
    const below=rect.bottom+gap;active.style.top=Math.max(gap,Math.min(below,win.innerHeight-box.height-gap))+'px';
  }
  listen(root,'click',event=>{const button=event.target.closest('[data-library-panel]');if(!button)return;const panel=doc.getElementById(button.dataset.libraryPanel);if(!panel||!root.contains(panel))return;
    const same=active===panel;close();if(same)return;active=panel;opener=button;active.hidden=false;opener.setAttribute('aria-expanded','true');position();active?.querySelector('button:not([hidden]):not(:disabled),select:not(:disabled),input:not(:disabled)')?.focus({preventScroll:true});
  });
  listen(doc,'pointerdown',event=>{if(active&&!active.contains(event.target)&&!opener.contains(event.target))close();});
  listen(doc,'keydown',event=>{if(!active)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close({focus:true});}else if(event.key==='Tab')setTimeout(()=>{if(active&&!active.contains(doc.activeElement)&&doc.activeElement!==opener)close();},0);},true);
  listen(root,'click',event=>{if(active&&active.contains(event.target)&&event.target.closest('button:not([data-library-keep-open])'))close({focus:true});});
  listen(win,'resize',()=>close());listen(doc,'scroll',event=>{if(active&&!active.contains(event.target)&&!positionFrame)positionFrame=win.requestAnimationFrame(()=>{positionFrame=null;position();});},true);
  return {close,closeWithin(node){if(active&&node.contains(active))close();},isOpen:()=>Boolean(active),dispose(){close();listeners.forEach(remove=>remove());}};
}
