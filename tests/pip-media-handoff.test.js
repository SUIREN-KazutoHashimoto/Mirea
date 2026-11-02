import test from 'node:test';
import assert from 'node:assert/strict';
import {adoptPlayerMedia} from '../web/src/pip-media-handoff.js';

class Element extends EventTarget{
  children=[];parent=null;style={};root=false;attributes={};moves=0;
  get isConnected(){return this.root||Boolean(this.parent?.isConnected);}
  setAttribute(key,value){this.attributes[key]=value;}
  append(child){child.remove();this.children.push(child);child.parent=this;child.moves++;}
  contains(element){return this===element||this.children.some(child=>child.contains(element));}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}}
  replaceWith(other){const parent=this.parent;if(!parent)return;other.remove();parent.children[parent.children.indexOf(this)]=other;other.parent=parent;other.moves++;this.parent=null;}
}
const element=parent=>{const value=new Element();parent?.append(value);return value;};
test('successive PiP tracks never disconnect/move the video and restore into the current player on exit',()=>{
  const page=element();page.root=true;const original=element(page),video=element(original),doc={pictureInPictureElement:video},moves=video.moves;
  const first=element(page),placeholder=element(first),handoff=adoptPlayerMedia(placeholder,video,{document:doc,retainedHost:original,preservePictureInPicture:true});
  assert.equal(video.parent,original);assert.equal(video.moves,moves);assert(video.isConnected);assert.equal(original.attributes['aria-hidden'],'true');
  handoff.dispose({preserveMedia:true});
  const second=element(page),nextPlaceholder=element(second),next=adoptPlayerMedia(nextPlaceholder,video,{document:doc,retainedHost:first,preservePictureInPicture:true});
  assert.equal(video.parent,original);assert.equal(video.moves,moves);assert(video.isConnected);assert.equal(first.isConnected,false);
  doc.pictureInPictureElement=null;video.dispatchEvent(new Event('leavepictureinpicture'));
  assert.equal(video.parent,second);assert(video.isConnected);assert.equal(original.isConnected,false);assert.equal(video.moves,moves+1);next.dispose();assert(video.isConnected);
});
test('Safari presentation changes restore the retained video and final disposal removes a retained host',()=>{
  const page=element();page.root=true;const host=element(page),video=element(host),next=element(page),placeholder=element(next);video.webkitPresentationMode='picture-in-picture';
  const handoff=adoptPlayerMedia(placeholder,video,{document:{},retainedHost:host,preservePictureInPicture:true});
  video.dispatchEvent(new Event('webkitpresentationmodechanged'));assert.equal(video.parent,host);
  video.webkitPresentationMode='inline';video.dispatchEvent(new Event('webkitpresentationmodechanged'));assert.equal(video.parent,next);assert.equal(host.isConnected,false);handoff.dispose();
  const pinned=element(page),another=element(pinned),container=element(page);another.webkitPresentationMode='picture-in-picture';const pending=adoptPlayerMedia(element(container),another,{document:{},retainedHost:pinned,preservePictureInPicture:true});pending.dispose();assert.equal(pinned.isConnected,false);
});
test('if PiP already ended, adoption moves the video normally and removes the old empty host',()=>{
  const page=element();page.root=true;const old=element(page),video=element(old),current=element(page),placeholder=element(current);
  const handoff=adoptPlayerMedia(placeholder,video,{document:{pictureInPictureElement:null},retainedHost:old,preservePictureInPicture:true});
  assert.equal(video.parent,current);assert.equal(old.isConnected,false);handoff.dispose();assert(video.isConnected);
});
