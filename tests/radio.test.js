import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';

const prefix = 'mirea-radio-test-';
const epoch = Date.parse('2026-01-01T00:00:00Z');
const pass = 'synthetic-radio-password';
const contents = Buffer.from('ID3 fixture payload for transport checks only');
const manifest = {
  name: 'Synthetic Station', epoch: new Date(epoch).toISOString(),
  tracks: [{title: 'Tone A', file: 'a.mp3', durationMs: 5000}, {title: 'Tone B', file: 'b.mp3', durationMs: 6000}]
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), prefix)), radioDir = join(dir, 'station');
  t.after(async () => {
    assert(resolve(dir).startsWith(resolve(tmpdir()) + sep + prefix));
    await rm(dir, {recursive: true, force: true});
  });
  await mkdir(radioDir);
  const write = config => writeFile(join(radioDir, 'station.json'), JSON.stringify(config));
  await Promise.all([write(manifest), writeFile(join(radioDir, 'a.mp3'), contents), writeFile(join(radioDir, 'b.mp3'), contents)]);
  return {radioDir, write, dataDir: join(dir, 'data')};
}

test('radio joins an advancing shared program, protects metadata and all media GET/HEAD, and survives restart', async t => {
  const f = await fixture(t);
  let now = epoch, app = await createApp({dataDir: f.dataDir, radioDir: f.radioDir, radioNow: () => now, allowRegistration: true});
  // Cleanup must close SQLite before removing its temp directory on Windows.
  try {
    const signup = async name => {
      const r = await app.inject({method: 'POST', url: '/api/v1/auth/register',
        payload: {name, email: name + '@example.test', password: pass, remember: false}});
      assert.equal(r.statusCode, 201);
      return {authorization: 'Bearer ' + r.json().token};
    };
    const [a, b] = [await signup('first'), await signup('second')];
    const status = '/api/v1/radio/now';
    const read = async headers => {
      const r = await app.inject({url: status, headers});
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.headers['cache-control'], 'no-store');
      return r.json();
    };
    assert.equal((await app.inject({url: '/api/v1/config'})).json().radioEnabled, true);
    assert.equal((await app.inject({url: status})).statusCode, 401);
    now += 7700;  // The station advanced without any listener requests.
    const program = await read(a);
    assert.deepEqual(program, {station: manifest.name, title: 'Tone B', serverTime: epoch + 7700, startTime: epoch + 5000,
      durationMs: 6000, mediaUrl: '/api/v1/radio/tracks/1/content'});
    now += 1300;
    const later = await read(b);
    assert.equal(later.startTime, program.startTime);
    assert.notEqual(later.serverTime, program.serverTime);
    for (const id of [0, 1]) for (const method of ['GET', 'HEAD']) {
      const url = '/api/v1/radio/tracks/' + id + '/content';
      assert.equal((await app.inject({url, method})).statusCode, 401);
      const media = await app.inject({url, headers: b, method});
      assert.equal(media.statusCode, 200, media.body);
      assert.equal(media.headers['content-type'], 'audio/mpeg');
      assert.equal(media.headers['cache-control'], 'private, no-store, no-transform');
      assert.equal(media.rawPayload.length, method === 'HEAD' ? 0 : contents.length);
      if (method === 'GET') assert.deepEqual(media.rawPayload, contents);
    }
    await app.inject({method:'POST', url:'/api/v1/auth/logout', headers:a});
    assert.equal((await app.inject({url: program.mediaUrl, headers: a})).statusCode, 401);
    assert.equal((await app.inject({url:'/api/v1/radio/tracks/2/content', headers:b})).statusCode, 404);
    await app.close();
    app = await createApp({dataDir: f.dataDir, radioDir: f.radioDir, radioNow: () => now});
    assert.deepEqual(await read(b), later);
    now = epoch + 11000;
    assert.equal((await read(b)).title, 'Tone A');
  } finally { await app.close(); }
});

test('radio is opt-in, and invalid track paths do not get exposed', async t => {
  const f = await fixture(t);
  const app = await createApp({dataDir:f.dataDir, radioDir:''});
  try { assert.equal((await app.inject({url:'/api/v1/config'})).json().radioEnabled, false); }
  finally { await app.close(); }
  await f.write({...manifest, tracks:[{...manifest.tracks[0], file:'../secret.mp3'}]});
  await assert.rejects(createApp({dataDir:f.dataDir, radioDir:f.radioDir}), /Invalid radio track metadata/);
});


test('saved playlist radio follows playlist order without granting a shelf member playlist access', async t => {
  const f = await fixture(t);
  const opts = {dataDir:f.dataDir, radioDir:'', allowRegistration:true, rateLimit:false};
  let now = epoch, app = await createApp(opts), db;
  const request = (method, url, headers, payload) => app.inject({method, url:'/api/v1'+url, headers, payload});
  const json = async (method, url, headers, payload, expected=200) => {
    const r = await request(method, url, headers, payload);
    assert.equal(r.statusCode, expected, r.body);
    return r.json();
  };
  const signup = name => json('POST','/auth/register',{}, {name,email:name+'@example.test',password:pass,remember:false},201);
  const header = session => ({authorization:'Bearer '+session.token});
  const restart = async () => {
    await app.close();
    app = await createApp({...opts,radioDir:f.radioDir, radioNow:() => now});
  };
  try {
    const owner = await signup('playlist-owner'), viewer = await signup('shelf-member');
    const u = header(owner), v = header(viewer);
    const second = header(await json('POST','/auth/login',{}, {email:owner.user.email,password:pass,remember:false}));
    assert.notEqual(second.authorization, u.authorization);
    const shelf = (await json('POST','/shelves',u,{name:'Synthetic Radio'},201)).id;
    const otherShelf = (await json('POST','/shelves',v,{name:'Revocable shelf'},201)).id;
    await json('POST',`/shelves/${shelf}/members`,u,{email:viewer.user.email,role:'viewer'},201);
    await json('POST',`/shelves/${otherShelf}/members`,v,{email:owner.user.email,role:'viewer'},201);
    db = new DatabaseSync(join(f.dataDir,'mirea.sqlite'));
    db.exec('PRAGMA foreign_keys=ON');
    const insertItem = db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)');
    const insertAudio = db.prepare('INSERT INTO audio_assets VALUES(?,?,0)');
    const seed = async (title, duration, trackShelf=shelf) => {
      const id=randomUUID(), bytes=Buffer.from('Synthetic AAC transport fixture: '+title);
      insertItem.run(id,trackShelf,title,'synthetic.m4a','audio/mp4',bytes.length,owner.user.id,Date.now());
      insertAudio.run(id,JSON.stringify({duration,codec:'AAC-LC'}));
      await writeFile(join(f.dataDir,'uploads',id),bytes);
      return {id,bytes};
    };
    const a=await seed('Opening',5), b=await seed('Interlude',6,otherShelf), c=await seed('Finale',8);
    const invalid=await seed('Ineligible short clip',0.3);
    const playlist=(await json('POST','/playlists',u,{title:'Saved program'},201)).playlist;
    const changed=(await json('PUT',`/playlists/${playlist.id}`,u,{revision:playlist.revision,title:playlist.title,assetIds:[b.id,invalid.id,a.id,c.id]})).playlist;
    await f.write({name:manifest.name,epoch:manifest.epoch,playlistId:playlist.id});
    await restart();
    const read = headers => json('GET','/radio/now',headers);
    assert.equal((await json('GET','/config',{})).radioEnabled,false);
    assert.equal((await json('GET','/config',v)).radioEnabled,false);
    assert.equal((await json('GET','/config',second)).radioEnabled,true);
    now=epoch+2300;
    const first=await read(u), joined=await read(second);
    assert.deepEqual(first, joined);
    assert.equal(joined.title,'Interlude');
    assert.equal(joined.startTime, epoch);
    assert.equal(joined.durationMs, 6000);
    const media=first.mediaUrl.replace('/api/v1','');
    assert.equal((await request('GET','/radio/now',{})).statusCode,401);
    assert.equal((await request('GET','/radio/now',v)).statusCode,404);
    for (const method of ['GET','HEAD']) {
      assert.equal((await request(method,media,{})).statusCode,401);
      assert.equal((await request(method,media,v)).statusCode,404);
      const served=await request(method,media,second);
      assert.equal(served.statusCode,200, served.body);
      assert.equal(served.headers['content-type'],'audio/mp4');
      assert.equal(served.headers['cache-control'],'private, no-store, no-transform');
      assert.deepEqual(served.rawPayload,method==='GET'?b.bytes:Buffer.alloc(0));
    }
    now=epoch+6800;
    const secondTrack=await read(second);
    assert.equal(secondTrack.title,'Opening');
    assert.equal(secondTrack.startTime, epoch+6000);
    assert.equal((await request('GET',secondTrack.mediaUrl.replace('/api/v1',''),v)).statusCode,404);
    assert.equal((await request('GET',`/items/${a.id}/content`,v)).statusCode,200,'non-owner is a valid shelf member');
    now=epoch+11100;
    assert.equal((await read(u)).title,'Finale');

    // A track already in the snapshot is no longer available after a
    // membership change, even if a captured media URL is used directly.
    assert.equal((await request('DELETE',`/shelves/${otherShelf}/members/${owner.user.id}`,v)).statusCode,204);
    for (const method of ['GET','HEAD']) assert.equal((await request(method,media,u)).statusCode,404);
    assert.equal((await request('GET','/radio/now',u)).statusCode,404);
    await restart();
    now=epoch+100;
    const afterLoss=await read(u);
    assert.equal(afterLoss.title,'Opening');
    assert.notEqual(afterLoss.mediaUrl,secondTrack.mediaUrl);
    assert.equal((await request('GET',secondTrack.mediaUrl.replace('/api/v1',''),u)).statusCode,404);

    const edited=(await json('PUT',`/playlists/${playlist.id}`,u,
      {revision:changed.revision,title:playlist.title,assetIds:[c.id,a.id]})).playlist;
    assert.equal((await request('GET','/radio/now',u)).statusCode,404,'playlist edits invalidate old plan');
    assert.equal((await request('HEAD',afterLoss.mediaUrl.replace('/api/v1',''),u)).statusCode,404);
    await restart();
    const editedProgram=await read(u);
    assert.equal(editedProgram.title,'Finale');
    db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(shelf);
    assert.equal((await request('GET',editedProgram.mediaUrl.replace('/api/v1',''),u)).statusCode,404,'private shelf is not a broadcast input');
    await restart();
    assert.equal((await request('GET','/radio/now',u)).statusCode,404);
    db.prepare('UPDATE shelves SET private=0 WHERE id=?').run(shelf);
    await restart();
    const beforeDelete=await read(u);
    assert.equal((await request('DELETE',`/playlists/${playlist.id}`,u,{revision:edited.revision})).statusCode,204);
    assert.equal((await request('GET',beforeDelete.mediaUrl.replace('/api/v1',''),u)).statusCode,404);
    assert.equal((await request('GET','/radio/now',u)).statusCode,404);
  } finally {
    db?.close();
    await app.close();
  }
});
