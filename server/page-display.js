import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {IMAGE_BOOK_MIME,imageExtension} from './media.js';
import {httpError} from './security.js';

export const PAGE_DISPLAY_EDGE=2400;
export function pageDisplayInfo(itemId,page){
  const scale=Math.min(1,PAGE_DISPLAY_EDGE/Math.max(page.width,page.height));
  return {displayUrl:`/api/v1/items/${itemId}/pages/${page.page_number}/display`,displayWidth:Math.max(1,Math.round(page.width*scale)),displayHeight:Math.max(1,Math.round(page.height*scale))};
}
// Original page files and encrypted downloads are untouched. Generated views
// live beside each book, so deleting a book removes these derived files too.
export function registerImageDisplays(app,{db,authenticate,findItem,requireShelfUnlock,booksDir,media}){
  const pending=new Map();
  const valid=async path=>{const value=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});if(value&&(!value.isFile()||value.isSymbolicLink()||value.size>8*1024*1024))throw httpError(500,'表示用ページを確認できません。');return value?.size?value:null;};
  const auth={onRequest:async req=>authenticate(req)};
  app.route({method:['GET','HEAD'],url:'/api/v1/items/:id/pages/:number/display',config:{maintenanceWrite:true},...auth,handler:async(req,reply)=>{
    const item=findItem(req.params.id,req.user.id);
    if(item.mime_type!==IMAGE_BOOK_MIME||!/^\d{1,4}$/.test(req.params.number))throw httpError(404,'ページが見つかりません。');
    const page=db.prepare('SELECT * FROM image_pages WHERE item_id=? AND page_number=?').get(item.id,Number(req.params.number));if(!page)throw httpError(404,'ページが見つかりません。');
    const directory=join(booksDir,item.id),path=join(directory,`${page.page_number}.display-v1.webp`),key=item.id+':'+page.page_number;
    if(!await valid(path)){
      let job=pending.get(key);
      if(!job){
        if(pending.size>=32){reply.header('Retry-After','5');throw httpError(503,'ページの準備が混み合っています。少し待って再試行してください。');}
        job=(async()=>{const temporary=join(directory,`${page.page_number}.display-${randomUUID()}.webp`);
          try{await media.pageDisplay(join(directory,`${page.page_number}.${imageExtension(page.mime_type)}`),temporary);if(!await valid(temporary))throw Error('Empty page display');
            // A deletion during decoding must never recreate a removed book.
            if(!db.prepare('SELECT 1 FROM image_pages WHERE item_id=? AND page_number=?').get(item.id,page.page_number))throw httpError(404,'ページが削除されました。');
            await rename(temporary,path);
          }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
        })().finally(()=>pending.delete(key));pending.set(key,job);
      }
      await job;
    }
    const size=(await valid(path))?.size;if(!size)throw httpError(404,'ページが見つかりません。');
    // Decoding may wait behind another reader. Recheck the current shelf as
    // well as membership/session, including moves or a newly private shelf.
    authenticate(req);const current=findItem(item.id,req.user.id);requireShelfUnlock(req,current.shelf_id);
    reply.type('image/webp').header('Content-Length',size).header('Cache-Control','private, no-store');
    if(req.method==='HEAD')return reply.send();
    return reply.send(createReadStream(path));
  }});
}
