import { deflateRawSync } from 'node:zlib';
export function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
export function makeZip(files) {
  const local=[],central=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name),plain=Buffer.from(file.data??''),bytes=file.deflate?deflateRawSync(plain):plain,method=file.deflate?8:0,crc=crc32(plain);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800|(file.flags??0),6);header.writeUInt16LE(method,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(file.expanded??plain.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,bytes);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800|(file.flags??0),8);record.writeUInt16LE(method,10);record.writeUInt32LE(crc,16);record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(file.expanded??plain.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(file.attributes??0,38);record.writeUInt32LE(offset,42);central.push(record,name);offset+=header.length+name.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function epubFiles({version='3.0',cover,extra=[],body,opfExtra='',spineExtra='',encryption}={}) {
  return [
    {name:'mimetype',data:'application/epub+zip'},
    {name:'META-INF/container.xml',data:'<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'},
    {name:'OEBPS/book.opf',deflate:true,data:`<package version="${version}" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>試験の本 &amp; Test</dc:title><dc:creator>著者</dc:creator>${opfExtra}</metadata><manifest><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${cover?'<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>':''}${encryption?'<item id="font" href="font.otf" media-type="application/vnd.ms-opentype"/>':''}</manifest><spine page-progression-direction="rtl" ${spineExtra}><itemref idref="one"/><itemref idref="two"/></spine></package>`},
    {name:'OEBPS/one.xhtml',deflate:true,data:body??`<!DOCTYPE html><html><head><title>章</title></head><body><h1 id="start">第一章</h1><p>日本語の本文 &amp; &#x672c; <ruby>漢字<rt>かんじ</rt></ruby></p>${cover?'<img src="cover.png" alt="表紙"/>':''}<a href="two.xhtml#next">次章</a></body></html>`},
    {name:'OEBPS/two.xhtml',deflate:true,data:'<html><body><h1 id="next">第二章</h1><p>続きの文章です。</p></body></html>'},
    {name:'OEBPS/nav.xhtml',data:'<html><body><nav><a href="one.xhtml">はじまり</a><a href="two.xhtml">つづき</a></nav></body></html>'},
    ...(cover?[{name:'OEBPS/cover.png',data:cover}]:[]),
    ...(encryption?[{name:'META-INF/encryption.xml',data:encryption},{name:'OEBPS/font.otf',data:'ignored obfuscated font'}]:[]),
    ...extra
  ];
}
export const makeEpub=options=>makeZip(epubFiles(options));
