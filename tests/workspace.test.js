import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheme, resolveTheme } from '../web/src/theme.js';
import { bookScale, bookDirection } from '../web/src/book-viewer.js';
import { formatVideoTime, seekVideo } from '../web/src/video-player.js';

test('theme follows system unless explicitly set, persists per device and tolerates unavailable storage',()=>{
  const root={dataset:{},style:{}},media=new EventTarget();media.matches=true;
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const theme=createTheme({root,media,storage});assert.equal(root.dataset.theme,'dark');
  theme.set('light');assert.equal(root.style.colorScheme,'light');assert.equal(values.get('mirea.theme'),'light');
  media.dispatchEvent(new Event('change'));assert.equal(root.dataset.theme,'light');
  theme.set('system');media.matches=false;media.dispatchEvent(new Event('change'));assert.equal(root.dataset.theme,'light');
  assert.throws(()=>theme.set('invalid'));theme.dispose();
  const unavailable=createTheme({root,media,storage:{getItem(){throw Error();},setItem(){throw Error();}}});unavailable.set('dark');assert.equal(root.dataset.theme,'dark');unavailable.dispose();
  assert.equal(resolveTheme('system',true),'dark');assert.equal(resolveTheme('dark',false),'dark');
});
test('book fit includes both page dimensions, respects scale caps and opens right-to-left without reversing PageDown',()=>{
  assert.equal(bookScale(600,900,1208,908),1);assert.equal(bookScale(600,900,308,1000),.5);
  assert.equal(bookScale(100,100,2000,2000,'fit',1),1);assert.equal(bookScale(600,900,50,50,'2'),2);
  assert.equal(bookDirection('ArrowRight','ltr'),1);assert.equal(bookDirection('ArrowRight','rtl'),-1);
  assert.equal(bookDirection('ArrowLeft','rtl'),1);assert.equal(bookDirection('PageDown','rtl'),1);assert.equal(bookDirection('PageUp','ltr'),-1);assert.equal(bookDirection('x','ltr'),0);
});
test('video controls format short/long media and clamp seeking to actual duration',()=>{
  assert.equal(formatVideoTime(5.2),'0:05');assert.equal(formatVideoTime(3661),'1:01:01');assert.equal(formatVideoTime(Infinity),'0:00');
  const video={duration:5.2,currentTime:1};seekVideo(video,100);assert.equal(video.currentTime,5.2);seekVideo(video,-10);assert.equal(video.currentTime,0);
  video.duration=NaN;seekVideo(video,2);assert.equal(video.currentTime,0);
});
