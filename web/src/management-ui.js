export function progressPercent(value){const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):0;}
export function displayTime(value){const n=Number(value);return Number.isFinite(n)&&n>0&&n<=8640000000000000?new Date(n).toLocaleString(undefined,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';}

// Progress polling must not discard focus, expanded details or scroll position.
export function keyedRenderer(container,{key,create,update,after=null}){
  const records=new Map();
  return rows=>{const seen=new Set();let cursor=after?after.nextSibling:container.firstChild;
    for(const row of rows){const id=String(key(row));if(seen.has(id))continue;seen.add(id);let record=records.get(id);if(!record){record=create(row);records.set(id,record);}update(record,row);if(record.element!==cursor)container.insertBefore(record.element,cursor);cursor=record.element.nextSibling;}
    for(const [id,record]of records)if(!seen.has(id)){record.element.remove();records.delete(id);}
  };
}
export function sectionNavigation(items,{esc,prefix,label}){
  return `<nav class="manager-nav" aria-label="${esc(label)}">${items.map(([id,title,hint])=>`<button type="button" data-manager-section="${id}" aria-controls="${prefix}-${id}" aria-current="false"><span>${esc(title)}</span>${hint?`<small>${esc(hint)}</small>`:''}</button>`).join('')}</nav><label class="manager-mobile-nav">${esc(label)}<select class="manager-section-select">${items.map(([id,title])=>`<option value="${id}">${esc(title)}</option>`).join('')}</select></label>`;
}
export function bindSections(root,{items,initial,onChange=()=>{}}){
  const allowed=new Set(items.map(([id])=>id)),select=root.querySelector('.manager-section-select');
  const activate=id=>{if(!allowed.has(id))return;root.querySelectorAll('[data-manager-section]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.managerSection===id)));root.querySelectorAll('[data-manager-panel]').forEach(p=>p.hidden=p.dataset.managerPanel!==id);select.value=id;const scroller=root.querySelector('.manager-panel');if(scroller)scroller.scrollTop=0;onChange(id);};
  root.querySelectorAll('[data-manager-section]').forEach(b=>b.onclick=()=>activate(b.dataset.managerSection));select.onchange=()=>activate(select.value);activate(initial??items[0][0]);return activate;
}
