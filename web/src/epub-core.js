const tags = new Set('p div span h1 h2 h3 h4 h5 h6 section article blockquote pre code em strong b i u s small sub sup ruby rt rp ul ol li dl dt dd br hr figure figcaption table thead tbody tr td th caption img a'.split(' '));
export function validateEpubBundle(book) {
  if (book?.version !== 1 || !['ltr','rtl'].includes(book.direction) || !Array.isArray(book.chapters) || !book.chapters.length || book.chapters.length>500 || !Array.isArray(book.resources) || book.resources.length>1000) throw Error('EPUBの閲覧データが不正です。');
  let nodes=0, text=0, images=0;
  for (const resource of book.resources) {
    if (resource.mime!=='image/jpeg' || typeof resource.data!=='string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(resource.data) || resource.data.length%4) throw Error('EPUBの挿絵が不正です。');
    images+=resource.data.length;
  }
  function validate(children,depth=0) {
    if (!Array.isArray(children) || depth>64) throw Error('EPUBの構造が不正です。');
    for (const node of children) {
      if (++nodes>120000 || !node || typeof node!=='object') throw Error('EPUBの要素数が上限を超えています。');
      if (node.text!==undefined) { if(typeof node.text!=='string')throw Error('EPUBの本文が不正です。');text+=node.text.length;continue; }
      if (!tags.has(node.tag) || node.id!==undefined && (typeof node.id!=='string'||node.id.length>200)) throw Error('EPUBの要素が不正です。');
      if (node.tag==='img') { if(!Number.isInteger(node.image)||!book.resources[node.image])throw Error('EPUBの挿絵参照が不正です。'); }
      else {
        if(node.tag==='a' && (!Number.isInteger(node.chapter)||!book.chapters[node.chapter]||typeof node.anchor!=='string'||node.anchor.length>200))throw Error('EPUBのリンクが不正です。');
        validate(node.children,depth+1);
      }
    }
  }
  for (const chapter of book.chapters) { if(typeof chapter.title!=='string'||chapter.title.length>200)throw Error('EPUBの目次が不正です。'); validate(chapter.children); }
  if(text>12*1024*1024 || images>28*1024*1024)throw Error('EPUBの閲覧データが大きすぎます。');
  return book;
}
export const epubScreen = (fraction,count) => Math.max(0,Math.min(count-1,Math.round((Number.isFinite(fraction)?fraction:0)*Math.max(0,count-1))));
export const epubFraction = (screen,count) => count>1?Math.max(0,Math.min(1,screen/(count-1))):0;

// Build only allowlisted elements; no book HTML, CSS, URLs or event attributes enter the DOM.
export function renderEpubChapter(chapter,{doc=document,imageUrl,onLink}) {
  const anchors=new Map();
  function render(value) {
    if(value.text!==undefined)return doc.createTextNode(value.text);
    const node=doc.createElement(value.tag);
    if(value.id && !anchors.has(value.id))anchors.set(value.id,node);
    if(value.tag==='img'){node.src=imageUrl(value.image);node.alt=value.alt??'挿絵';node.draggable=false;}
    else {
      for(const child of value.children)node.append(render(child));
      if(value.tag==='a'){node.href='#';node.onclick=event=>{event.preventDefault();event.stopPropagation();onLink(value.chapter,value.anchor);};}
    }
    return node;
  }
  const fragment=doc.createDocumentFragment();for(const node of chapter.children)fragment.append(render(node));
  return {fragment,anchors};
}
