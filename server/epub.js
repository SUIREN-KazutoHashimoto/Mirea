// EPUB is untrusted input. Never extract paths or serve its HTML/CSS directly.
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { parse } from 'parse5';
import { posix } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { MAX_EPUB_BYTES, MAX_EPUB_EXPANDED, MAX_EPUB_BUNDLE } from './ebook-types.js';

const fail = message => { throw new Error(message); };
const safePath = path => {
  if (!path || path.length > 1000 || /[\\\u0000-\u001f:?#]/.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.')) fail('Unsafe EPUB path');
  return path;
};
function reference(base, href) {
  if (!href || /^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) return null;
  try {
    const [path, hash = ''] = href.split('#');
    if (path.includes('?') || /[\\\u0000-\u001f:]/.test(path)) return null;
    const decoded = decodeURIComponent(path);
    if (decoded.startsWith('/') || /[\\\u0000-\u001f:]/.test(decoded)) return null;
    const target = posix.normalize(posix.join(posix.dirname(base), decoded || posix.basename(base)));
    safePath(target);
    return { path:target, hash:decodeURIComponent(hash).slice(0,200) };
  } catch { return null; }
}
function decode(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding,{fatal:true}).decode(bytes);
}
function xml(bytes) {
  const root = { name:'root', attrs:{}, children:[], text:'' }, stack = [root]; let nodes = 0;
  const parser = new SaxesParser({xmlns:true});
  parser.on('doctype', () => fail('DTD is not supported'));
  parser.on('opentag', tag => {
    if (++nodes > 12000 || stack.length > 48) fail('XML complexity limit');
    const node = { name:tag.local, attrs:Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value])), children:[], text:'' };
    stack.at(-1).children.push(node); stack.push(node);
  });
  parser.on('text', text => { stack.at(-1).text += text; });
  parser.on('cdata', text => { stack.at(-1).text += text; });
  parser.on('closetag', () => stack.pop());
  parser.on('error', error => { throw error; });
  parser.write(decode(bytes)).close(); return root;
}
const descendants = (node, name) => node.children.flatMap(child => [...(child.name === name ? [child] : []), ...descendants(child,name)]);
const tags = new Set('p div span h1 h2 h3 h4 h5 h6 section article blockquote pre code em strong b i u s small sub sup ruby rt rp ul ol li dl dt dd br hr figure figcaption table thead tbody tr td th caption'.split(' '));
const discard = new Set('script style iframe object embed link meta base form input button select textarea audio video source canvas math'.split(' '));
const imageTypes = new Set(['image/jpeg','image/png','image/webp','image/gif']);

export async function compileEpub(source, destination, bundlePath) {
  if ((await stat(source)).size > MAX_EPUB_BYTES) fail('EPUB is larger than 64 MiB');
  const zip = await yauzl.openPromise(source,{autoClose:false,strictFileNames:true,validateEntrySizes:true});
  try {
    const entries = new Map(); let expanded = 0;
    for await (const entry of zip.eachEntry()) {
      safePath(entry.fileName);
      const mode = entry.externalFileAttributes >>> 16;
      if (entries.size >= 5000 || entries.has(entry.fileName) || entry.generalPurposeBitFlag & 1 || (mode & 0xf000) === 0xa000 || ![0,8].includes(entry.compressionMethod)) fail('Unsupported or unsafe EPUB archive');
      expanded += entry.uncompressedSize;
      if (!Number.isSafeInteger(expanded) || expanded > MAX_EPUB_EXPANDED || entry.uncompressedSize > 16 * 1024 * 1024) fail('EPUB expanded size limit');
      entries.set(entry.fileName,entry);
    }
    let readBytes = 0;
    async function read(path, max = 2 * 1024 * 1024) {
      const entry = entries.get(path);
      if (!entry || entry.uncompressedSize > max || path.endsWith('/')) fail('Missing or oversized EPUB resource');
      const stream = await zip.openReadStreamPromise(entry), chunks = []; let size = 0, checksum = 0;
      try { for await (const chunk of stream) { size += chunk.length; readBytes += chunk.length; if (size > max || readBytes > MAX_EPUB_EXPANDED * 2) fail('EPUB decode size limit'); checksum=crc32(chunk,checksum); chunks.push(chunk); } }
      finally { stream.destroy(); }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32) fail('EPUB integrity mismatch');
      return Buffer.concat(chunks,size);
    }
    if ((await read('mimetype',64)).toString() !== 'application/epub+zip') fail('Not an EPUB');
    const container = xml(await read('META-INF/container.xml'));
    const opfPath = descendants(container,'rootfile').find(n=>n.attrs['media-type']==='application/oebps-package+xml')?.attrs['full-path'];
    safePath(opfPath);
    const opf = xml(await read(opfPath)), packageNode = descendants(opf,'package')[0];
    if (!packageNode) fail('Missing EPUB package');
    if (descendants(opf,'meta').some(n=>n.attrs.property==='rendition:layout' && n.text.trim()==='pre-paginated')) fail('Fixed-layout EPUB is not supported');
    const manifest = new Map();
    for (const node of descendants(opf,'manifest')[0]?.children ?? []) {
      if (node.name !== 'item') continue;
      const ref = reference(opfPath,node.attrs.href);
      if (!node.attrs.id || manifest.has(node.attrs.id) || !ref) fail('Invalid EPUB manifest');
      manifest.set(node.attrs.id,{...node.attrs,path:ref.path});
    }
    if (entries.has('META-INF/encryption.xml')) {
      const encryption = xml(await read('META-INF/encryption.xml'));
      for (const data of descendants(encryption,'EncryptedData')) {
        const algorithm = descendants(data,'EncryptionMethod')[0]?.attrs.Algorithm;
        const uri = descendants(data,'CipherReference')[0]?.attrs.URI;
        const font = [...manifest.values()].find(item=>item.path===uri && /font|opentype/.test(item['media-type']));
        // Obfuscated fonts are ignored (system fonts are used), never decrypted.
        if (!font || !['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(algorithm)) fail('DRM/encrypted EPUB is not supported');
      }
      if (!descendants(encryption,'EncryptedData').length) fail('Invalid EPUB encryption metadata');
    }
    const spine = descendants(opf,'spine')[0];
    const ordered = (spine?.children ?? []).filter(n=>n.name==='itemref' && n.attrs.linear!=='no').map(n=>manifest.get(n.attrs.idref));
    if (!ordered.length || ordered.length > 500 || ordered.some(n=>!n || !['application/xhtml+xml','text/html'].includes(n['media-type']))) fail('Unsupported EPUB spine');
    const title = descendants(opf,'title')[0]?.text.trim().slice(0,200) || 'EPUB', author = descendants(opf,'creator')[0]?.text.trim().slice(0,200) || '';
    const resources = [], resourceIds = new Map(); let resourceBytes = 0;
    async function image(path) {
      if (resourceIds.has(path)) return resourceIds.get(path);
      const item = [...manifest.values()].find(n=>n.path===path);
      if (!item || !imageTypes.has(item['media-type'])) return null;
      const input = await read(path,16*1024*1024);
      const converter = sharp(input,{limitInputPixels:40_000_000,failOn:'warning',pages:1});
      const metadata = await converter.metadata();
      if (!['jpeg','png','webp','gif'].includes(metadata.format)) fail('Unsupported EPUB image');
      const bytes = await converter.rotate().resize({width:1800,height:2400,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:88}).toBuffer();
      resourceBytes += bytes.length;
      if (resources.length >= 1000 || resourceBytes > 20 * 1024 * 1024) fail('EPUB image resource limit');
      const index = resources.length; resources.push({mime:'image/jpeg',data:bytes.toString('base64')}); resourceIds.set(path,index); return index;
    }
    let nodeCount = 0;
    async function sanitize(nodes, path, depth = 0) {
      if (depth > 64) fail('EPUB content depth limit');
      const result = [];
      for (const node of nodes) {
        if (++nodeCount > 120000) fail('EPUB content node limit');
        if (node.nodeName === '#text') { result.push({text:node.value}); continue; }
        const tag = node.tagName;
        if (!tag || discard.has(tag)) continue;
        const attrs = Object.fromEntries((node.attrs??[]).map(a=>[a.name,a.value]));
        if (tag === 'img' || tag === 'image') {
          const ref = reference(path,attrs.src ?? attrs.href), index = ref ? await image(ref.path) : null;
          if (index !== null) result.push({tag:'img',image:index,alt:(attrs.alt??'挿絵').slice(0,300)});
          else if (attrs.alt) result.push({text:attrs.alt.slice(0,300)});
          continue;
        }
        const children = await sanitize(node.childNodes??[],path,depth+1);
        const value = {tag:tags.has(tag)?tag:'span',children};
        if (attrs.id) value.id = attrs.id.slice(0,200);
        if (tag === 'a') {
          const ref = reference(path,attrs.href), chapter = ref ? ordered.findIndex(n=>n.path===ref.path) : -1;
          if (chapter >= 0) Object.assign(value,{tag:'a',chapter,anchor:ref.hash});
        }
        result.push(value);
      }
      return result;
    }
    const chapters = [];
    for (const [index,item] of ordered.entries()) {
      const source = decode(await read(item.path));
      if (/<!ENTITY/i.test(source)) fail('Custom entities are not supported');
      const document = parse(source), html = document.childNodes.find(n=>n.tagName==='html'), body = html?.childNodes.find(n=>n.tagName==='body');
      const children = await sanitize(body?.childNodes??[],item.path);
      const heading = (body?.childNodes??[]).find(n=>/^h[1-6]$/.test(n.tagName));
      const text = node => node.nodeName==='#text'?node.value:(node.childNodes??[]).map(text).join('');
      chapters.push({title:heading?text(heading).trim().slice(0,200):`第${index+1}章`,children});
    }
    // EPUB3 nav or EPUB2 NCX supplies the authored chapter titles.
    const nav = [...manifest.values()].find(n=>(n.properties??'').split(/\s+/).includes('nav'));
    if (nav) {
      const ast = parse(decode(await read(nav.path)));
      const walk = node => {
        if (node.tagName === 'a') {
          const ref = reference(nav.path,node.attrs?.find(a=>a.name==='href')?.value), index = ref ? ordered.findIndex(n=>n.path===ref.path) : -1;
          const text = n=>n.nodeName==='#text'?n.value:(n.childNodes??[]).map(text).join('');
          if (index>=0 && !ref.hash) chapters[index].title=text(node).trim().slice(0,200)||chapters[index].title;
        }
        for (const child of node.childNodes??[]) walk(child);
      }; walk(ast);
    } else {
      const ncx = manifest.get(spine?.attrs.toc);
      if (ncx) for (const point of descendants(xml(await read(ncx.path)),'navPoint')) {
        const ref = reference(ncx.path,descendants(point,'content')[0]?.attrs.src), index = ref ? ordered.findIndex(n=>n.path===ref.path) : -1;
        if (index>=0) chapters[index].title=descendants(point,'text')[0]?.text.trim().slice(0,200)||chapters[index].title;
      }
    }
    const declaredCover = [...manifest.values()].find(n=>(n.properties??'').split(/\s+/).includes('cover-image')) ?? manifest.get(descendants(opf,'meta').find(n=>n.attrs.name==='cover')?.attrs.content);
    const cover = declaredCover ? await image(declaredCover.path) : resources.length ? 0 : null;
    if (cover !== null) await sharp(Buffer.from(resources[cover].data,'base64')).resize({width:480,height:720,fit:'inside'}).jpeg({quality:82}).toFile(destination);
    else {
      const escape = text => text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
      const letters = [...title], lines = [0,18,36].map((start,index)=>`<text x="78" y="${270+index*42}" fill="white" font-size="21">${escape(letters.slice(start,start+18).join(''))}</text>`).join('');
      await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="680"><rect width="480" height="680" fill="#27344d"/><path d="M45 45v590" stroke="#a4b8ff" stroke-width="5"/><text x="78" y="190" fill="#b8c8ff" font-size="24">MIREA / EPUB</text>${lines}</svg>`)).jpeg().toFile(destination);
    }
    const bundle = JSON.stringify({version:1,title,author,direction:spine?.attrs['page-progression-direction']==='rtl'?'rtl':'ltr',chapters,resources});
    if (Buffer.byteLength(bundle)>MAX_EPUB_BUNDLE) fail('EPUB reading data size limit');
    if (bundlePath) await writeFile(bundlePath,bundle,{flag:'wx',mode:0o600});
    return {pageCount:chapters.length};
  } finally { zip.close(); }
}
