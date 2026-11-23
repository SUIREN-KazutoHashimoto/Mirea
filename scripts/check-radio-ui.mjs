// Browser acceptance for the opt-in radio, using local synthetic audio only.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, stat, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {createServer, mergeConfig} from 'vite';
import baseConfig from '../vite.config.js';
import {createApp} from '../server/app.js';
import {ffmpegPath} from '../server/media.js';

const temp = await mkdtemp(join(tmpdir(), 'mirea-radio-ui-'));
let app, vite, browser;
try {
  const radioDir = join(temp, 'station');
  await mkdir(radioDir);
  const saved = process.argv.includes('--saved-playlist');
  const tones = saved ? [440, 880, 660] : [440, 880];
  const dataDir = join(temp, 'data'), password = 'synthetic-radio-test-password';
  const request = async (method, url, payload, token, expected=200) => {
    const result = await app.inject({method,url:'/api/v1'+url,payload,headers:token?{authorization:'Bearer '+token}:{}});
    assert.equal(result.statusCode, expected, result.body);
    return result.json();
  };
  const register = name => request('POST','/auth/register',{name,email:name+'@example.test',password,remember:false},null,201);
  const tone = (hz,file,args) => promisify(execFile)(ffmpegPath(), ['-hide_banner','-loglevel','error','-f','lavfi','-i',
    'sine=frequency='+hz+':sample_rate=44100:duration=12',...args,file],{timeout:15000,windowsHide:true});
  let shift = 0;
  const epoch = Date.now(), station = {name:'Synthetic Station',epoch:new Date(epoch).toISOString()};
  const options = {dataDir,radioNow:() => Date.now()+shift,allowRegistration:true,rateLimit:false};
  let users;
  if (saved) {
    app = await createApp({...options,radioDir:''});
    const owner = await register('station-owner');
    const second = await request('POST','/auth/login',{email:owner.user.email,password,remember:false});
    assert.notEqual(owner.token,second.token);
    users = [owner,second];
    const shelf = await request('POST','/shelves',{name:'Synthetic radio shelf'},owner.token,201);
    const db = new DatabaseSync(join(dataDir,'mirea.sqlite'));
    const ids = [];
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const addItem = db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)');
      const addAudio = db.prepare('INSERT INTO audio_assets VALUES(?,?,0)');
      for (const hz of tones) {
        const id = randomUUID(), file = join(dataDir,'uploads',id);
        await tone(hz,file,['-c:a','aac','-b:a','64k','-movflags','+faststart','-f','ipod']);
        addItem.run(id,shelf.id,'Tone '+hz,'tone.m4a','audio/mp4',(await stat(file)).size,owner.user.id,epoch);
        addAudio.run(id,JSON.stringify({duration:12,codec:'AAC-LC'}));
        ids.push(id);
      }
    } finally { db.close(); }
    const {playlist} = await request('POST','/playlists',{title:'Synthetic program'},owner.token,201);
    await request('PUT','/playlists/'+playlist.id,{revision:playlist.revision,title:playlist.title,assetIds:ids},owner.token);
    await app.close();
    await writeFile(join(radioDir,'station.json'),JSON.stringify({...station,playlistId:playlist.id}));
    app = await createApp({...options,radioDir});
  } else {
    for (const hz of tones) await tone(hz,join(radioDir,hz+'.mp3'),['-b:a','64k']);
    await writeFile(join(radioDir,'station.json'),JSON.stringify({...station,
      tracks:tones.map(hz=>({title:'Tone '+hz,file:hz+'.mp3',durationMs:12000}))}));
    app = await createApp({...options,radioDir});
    users = await Promise.all(['first','second'].map(register));
  }
  await app.listen({host:'127.0.0.1', port:0});
  const target = 'http://127.0.0.1:' + app.server.address().port;
  vite = await createServer(mergeConfig(baseConfig, {configFile:false, cacheDir:join(temp,'vite-cache'), server:{
    host:'127.0.0.1', port:0, watch:null, hmr:false, proxy:{'/api': target}
  }}));
  await vite.listen();
  const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({headless:true, chromiumSandbox:true, ...(process.env.MIREA_UI_BROWSER ?
    {executablePath:process.env.MIREA_UI_BROWSER} : {})});
  const open = async user => {
    const context = await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*', route => new URL(route.request().url()).origin===origin ? route.continue() : route.abort('blockedbyclient'));
    await context.addInitScript(user => sessionStorage.setItem('mirea.session:web', JSON.stringify({origin:'',remember:false,session:user})),user);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); });
    await page.goto(origin);
    await page.locator('#nav-radio').waitFor({state:'attached'});
    const opener = page.locator('#open-drawer');
    if (await opener.isVisible()) await opener.click();
    await page.locator('#nav-radio').click();
    return page;
  };
  const errors=[];
  const [a,b] = await Promise.all(users.map(open));
  // Set the live clock to three seconds into the first tone, with no playback active yet.
  shift = epoch + 3000 - Date.now();
  const start = page => page.getByRole('button',{name:'聴く',exact:true}).click();
  const observing = async (page, hz) => {
    await page.waitForFunction(hz => document.querySelector('#radio-status')?.textContent.endsWith('Tone ' + hz), hz);
    const audio = page.locator('dialog.radio-dialog audio');
    await page.waitForFunction(() => {
      const el = document.querySelector('dialog.radio-dialog audio');
      return el && !el.paused && el.currentTime > 0 && el.readyState >= 2;
    });
    return audio.evaluate(async (element, expected) => {
      if (!window.radioProbe) {
        const ctx = new AudioContext();
        const src = ctx.createMediaElementSource(element), analyser = ctx.createAnalyser();
        analyser.fftSize = 8192;
        src.connect(analyser);
        await ctx.resume();
        window.radioProbe={ctx,analyser};
      }
      const {ctx,analyser}=window.radioProbe, bins=new Float32Array(analyser.frequencyBinCount);
      return new Promise((done,reject) => {
        const deadline=performance.now()+2000;
        const sample=()=>{
          analyser.getFloatFrequencyData(bins);
          let peak=0;
          for(let i=1;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;
          if(bins[peak]>-60 && Math.abs(peak*ctx.sampleRate/analyser.fftSize-expected)<10)return done({hz:peak*ctx.sampleRate/analyser.fftSize, position:element.currentTime});
          if(performance.now()>=deadline)return reject(Error('No matching tone. Last peak Hz=' + peak*ctx.sampleRate/analyser.fftSize + ', dB=' + bins[peak]));
          requestAnimationFrame(sample);
        };
        sample();
      });
    }, hz);
  };
  await start(a);
  const first = await observing(a, 440);
  assert(first.position >= 2.9, 'The first listener joins the running timeline, not the beginning');
  assert(Math.abs(first.hz-440)<10, 'The browser decoded the first sine tone');
  await new Promise(r=>setTimeout(r, 1000));
  await start(b);
  const second = await observing(b, 440);
  assert(second.position-first.position > 0.7, 'The second listener joins later in the same clip');
  assert(Math.abs(second.hz-440)<10);
  const [nextA,nextB]=await Promise.all([observing(a,880),observing(b,880)]);
  assert([nextA,nextB].every(result=>result.position<2 && Math.abs(result.hz-880)<10), 'Both listeners advanced to the next tone');
  const dialog = b.locator('dialog.radio-dialog');
  await dialog.locator('.close-modal').click();
  await dialog.waitFor({state:'detached'});
  assert.deepEqual(errors, []);
  console.log('Verified two Chromium listeners decode both sine tones on the shared program timeline; closing the player works.');
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  assert(resolve(temp).startsWith(resolve(tmpdir()) + sep + 'mirea-radio-ui-'));
  await rm(temp, {recursive:true, force:true});
}
