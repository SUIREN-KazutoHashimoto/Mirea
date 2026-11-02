import {isAudio} from './audio-types.js';
export function playlistKind(item){
  if(item?.kind==='video')return 'video';if(item?.kind==='audio')return 'audio';
  if(['pdf','epub','image-book'].includes(item?.kind))return 'book';
  const mime=item?.mime_type??item?.mimeType;
  return mime?.startsWith('video/')?'video':mime&&isAudio(mime)?'audio':['application/pdf','application/epub+zip','application/vnd.mirea.image-book'].includes(mime)?'book':null;
}
