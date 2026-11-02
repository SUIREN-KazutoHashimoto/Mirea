import {isAudio} from './audio-types.js';
import {IMAGE_TYPES} from './media.js';
import {EPUB_MIME} from './ebook-types.js';
export function pendingShelfUploads(db,shelfId){
  return db.prepare(`SELECT u.id,u.title,u.files_json,u.state,u.processing_json,u.created_at,s.id series_id,s.title series_title FROM upload_sessions u LEFT JOIN series s ON s.id=u.target_series_id AND s.shelf_id=u.shelf_id
    WHERE u.shelf_id=? AND (u.state='processing' OR u.state='uploading' AND u.expires_at>?)
    AND NOT EXISTS(SELECT 1 FROM items i WHERE i.id=u.id) ORDER BY u.created_at DESC,u.id`).all(shelfId,Date.now()).map(row=>{
      const mime=JSON.parse(row.files_json)[0]?.mime,kind=mime==='application/pdf'?'pdf':mime===EPUB_MIME?'epub':IMAGE_TYPES.includes(mime)?'image-book':isAudio(mime)?'audio':'video';
      const progress=JSON.parse(row.processing_json);
      return {id:row.id,title:row.title,shelfId,series:row.series_id?{id:row.series_id,title:row.series_title,position:Number.MAX_SAFE_INTEGER,label:''}:null,kind,mimeType:mime,pending:true,state:row.state,processing:{stage:progress.stage,percent:progress.percent},createdAt:row.created_at};
    });
}
