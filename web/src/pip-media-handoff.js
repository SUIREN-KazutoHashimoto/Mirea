import {isPictureInPicture} from './media-session.js';

// A browser PiP window belongs to a connected video element. Moving/removing
// that element while it is pinned can close the window, even in the same tab.
const hosts=new WeakMap();
export function adoptPlayerMedia(placeholder,media,{document:doc=globalThis.document,retainedHost,preservePictureInPicture=false}={}){
  let disposed=false;
  const prior=hosts.get(media),host=prior??retainedHost;
  const removeUnused=()=>{if(host&&!host.contains(media)){host.remove();if(hosts.get(media)===host)hosts.delete(media);}if(retainedHost&&retainedHost!==host&&!retainedHost.contains(media))retainedHost.remove();};
  const restore=()=>{if(disposed||isPictureInPicture(media,doc))return;if(placeholder.isConnected)placeholder.replaceWith(media);removeUnused();};
  if(preservePictureInPicture&&media.isConnected&&isPictureInPicture(media,doc)){
    if(host){hosts.set(media,host);host.setAttribute('aria-hidden','true');Object.assign(host.style,{position:'fixed',left:'-10000px',top:'0',width:'1px',height:'1px',overflow:'hidden',pointerEvents:'none'});}
    placeholder.hidden=true;
    if(retainedHost&&retainedHost!==host&&!retainedHost.contains(media))retainedHost.remove();
    media.addEventListener('leavepictureinpicture',restore);media.addEventListener('webkitpresentationmodechanged',restore);
  }else{placeholder.replaceWith(media);removeUnused();}
  return {dispose({preserveMedia=false}={}){if(disposed)return;disposed=true;media.removeEventListener('leavepictureinpicture',restore);media.removeEventListener('webkitpresentationmodechanged',restore);if(!preserveMedia){if(host)host.remove();if(retainedHost&&retainedHost!==host)retainedHost.remove();hosts.delete(media);}}};
}
