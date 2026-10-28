// Retain card/button/cover identity across background refreshes. Generated HTML
// is compared separately from live artwork, preview video and focus state.
const signatures=new WeakMap();
const key=node=>{const button=node.querySelector('[data-open],[data-open-series],[data-open-playlist]');return button?.dataset.openSeries?'series:'+button.dataset.openSeries:button?.dataset.openPlaylist?'playlist:'+button.dataset.openPlaylist:'asset:'+(button?.dataset.open??node.dataset.assetId);};
function attributes(node,next){for(const attr of [...node.attributes])if(!next.hasAttribute(attr.name))node.removeAttribute(attr.name);for(const attr of next.attributes)if(node.getAttribute(attr.name)!==attr.value)node.setAttribute(attr.name,attr.value);}
export function patchCollection(container,html){
 const template=container.ownerDocument.createElement('template');template.innerHTML=html;
 const existing=new Map([...container.children].filter(n=>n.classList.contains('media-card')).map(n=>[key(n),n]));
 let cursor=container.firstElementChild;
 for(const fresh of [...template.content.children]){
  const id=key(fresh),signature=fresh.outerHTML;let card=existing.get(id);existing.delete(id);
  if(!card){card=fresh;signatures.set(card,signature);}
  else if(signatures.get(card)!==signature){
   const button=card.querySelector('.card-open'),next=fresh.querySelector('.card-open'),art=button?.querySelector('.card-art'),nextArt=next?.querySelector('.card-art'),cover=art?.querySelector('img'),nextCover=nextArt?.querySelector('img');
   if(button&&next){
    if(art&&nextArt&&cover?.dataset.localThumbnail===nextCover?.dataset.localThumbnail&&cover?.dataset.thumbnail===nextCover?.dataset.thumbnail)nextArt.replaceWith(art);
    attributes(button,next);
    button.replaceChildren(...next.childNodes);
   }else card.replaceChildren(...fresh.childNodes);
   attributes(card,fresh);
   signatures.set(card,signature);
  }
  if(card!==cursor)container.insertBefore(card,cursor);cursor=card.nextElementSibling;
 }
 for(const card of existing.values())card.remove();
 for(const node of [...container.children])if(!node.classList.contains('media-card'))node.remove();
}
