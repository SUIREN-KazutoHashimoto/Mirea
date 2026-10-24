import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm,access,symlink,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate,createHash} from 'node:crypto';
import {preflightTrueNas} from '../server/truenas-preflight.mjs';

const linux=process.platform==='linux'&&process.getuid()>0;
const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
async function fixture(t) {
  const folder=await mkdtemp(join(tmpdir(),'mirea-preflight-test-')),data=join(folder,'data'),media=join(folder,'media'),tls=join(data,'keys/tls');
  t.after(()=>rm(folder,{recursive:true,force:true}));
  await mkdir(tls,{recursive:true,mode:0o700});await mkdir(media,{mode:0o700});
  const ssl=(...args)=>execFileSync('openssl',args,{cwd:folder,stdio:'ignore',timeout:15000});
  ssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-days','2','-subj','/CN=Mirea isolated test CA','-addext','basicConstraints=critical,CA:TRUE');
  ssl('req','-new','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=mirea.example.test');
  await writeFile(join(folder,'extensions.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:mirea.example.test,IP:127.0.0.1\n');
  ssl('x509','-req','-in','leaf.csr','-CA','root.pem','-CAkey','root.key','-CAcreateserial','-out','leaf.pem','-days','1','-extfile','extensions.cnf');
  const leafPem=await readFile(join(folder,'leaf.pem')),rootPem=await readFile(join(folder,'root.pem')),leaf=new X509Certificate(leafPem),root=new X509Certificate(rootPem);
  await writeFile(join(tls,'server-key.pem'),await readFile(join(folder,'leaf.key')),{mode:0o600});
  await writeFile(join(tls,'server-chain.pem'),Buffer.concat([leafPem,rootPem]),{mode:0o644});
  await writeFile(join(tls,'suiren-root-ca.pem'),rootPem,{mode:0o644});
  // A caller's restrictive umask may strip public certificate read bits.
  await chmod(join(tls,'server-chain.pem'),0o644);await chmod(join(tls,'suiren-root-ca.pem'),0o644);
  const env={DATA_DIR:data,MEDIA_DIR:media,MIREA_STORAGE_GROUP_ID:String(process.getgid()),MIREA_INSTALL_ID:'isolated-mirea-test-installation',HTTPS_KEY_FILE:join(tls,'server-key.pem'),HTTPS_CERT_FILE:join(tls,'server-chain.pem'),HEALTHCHECK_CA_FILE:join(tls,'suiren-root-ca.pem'),HEALTHCHECK_TLS_SERVER_NAME:'mirea.example.test',MIREA_TLS_IP:'127.0.0.1',MIREA_TLS_ROOT_SHA256:sha(root.raw),MIREA_TLS_LEAF_SHA256:sha(leaf.raw),MIREA_TLS_SPKI_SHA256:sha(leaf.publicKey.export({type:'spki',format:'der'}))};
  return {folder,data,media,tls,env,receipt:join(data,'.truenas-mirea-bootstrap.json')};
}

test('NAS preflight accepts only the reviewed empty installation and preserves later data', {skip:!linux},async t=>{
  const f=await fixture(t);
  assert.equal((await preflightTrueNas(f)).freshInstall,true);
  const initial=await readFile(f.receipt);
  await writeFile(join(f.data,'mirea.sqlite'),'existing account fixture');await writeFile(join(f.media,'asset'),'preserved');
  assert.equal((await preflightTrueNas(f)).freshInstall,false);
  assert.deepEqual(await readFile(f.receipt),initial);assert.equal(await readFile(join(f.media,'asset'),'utf8'),'preserved');
  await assert.rejects(preflightTrueNas({...f,env:{...f.env,MIREA_INSTALL_ID:'different-installation-id'}}),/receipt mismatch/);
  await chmod(f.receipt,0o644);await assert.rejects(preflightTrueNas(f),/invalid installation receipt/);
});

test('NAS preflight fails before a receipt or DB is created on wrong pins, names, paths or identity', {skip:!linux},async t=>{
  const f=await fixture(t);
  for(const extra of [{MIREA_TLS_ROOT_SHA256:'0'.repeat(64)},{MIREA_TLS_LEAF_SHA256:'0'.repeat(64)},{MIREA_TLS_SPKI_SHA256:'0'.repeat(64)},{MIREA_TLS_IP:'127.0.0.2'},{HEALTHCHECK_TLS_SERVER_NAME:'wrong.example.test'},{DATA_DIR:f.media},{MEDIA_DIR:f.data},{MIREA_STORAGE_GROUP_ID:'bad'},{HTTPS_KEY_FILE:'/tmp/key'},{MIREA_INSTALL_ID:''}]) {
    await assert.rejects(preflightTrueNas({...f,env:{...f.env,...extra}}),/TrueNAS preflight/);
    await assert.rejects(access(f.receipt),{code:'ENOENT'});
  }
  await assert.rejects(preflightTrueNas({...f,identity:{uid:0,gid:0}}),/non-root/);
  await assert.rejects(access(join(f.data,'mirea.sqlite')),{code:'ENOENT'});
});

test('NAS preflight never adopts unreviewed data, encryption keys, media or permissive TLS', {skip:!linux},async t=>{
  const f=await fixture(t);
  for(const path of [join(f.data,'mirea.sqlite'),join(f.data,'keys/download-master.key'),join(f.tls,'unexpected.pem'),join(f.media,'old-asset')]) {
    await writeFile(path,'must remain');await assert.rejects(preflightTrueNas(f),/detected|unexpected TLS/);
    assert.equal(await readFile(path,'utf8'),'must remain');await assert.rejects(access(f.receipt),{code:'ENOENT'});await rm(path);
  }
  await chmod(join(f.tls,'server-key.pem'),0o644);await assert.rejects(preflightTrueNas(f),/permissions mismatch/);await chmod(join(f.tls,'server-key.pem'),0o600);
  await chmod(f.tls,0o755);await assert.rejects(preflightTrueNas(f),/permissions mismatch/);await chmod(f.tls,0o700);
  const link=join(f.folder,'data-link');await symlink(f.data,link);await assert.rejects(preflightTrueNas({...f,data:link,env:{...f.env,DATA_DIR:link}}),/symlinks/);
  assert.deepEqual(await readdir(f.data),['keys']);
  await writeFile(join(f.tls,'server-key.pem'),await readFile(join(f.folder,'root.key')));await assert.rejects(preflightTrueNas(f),/key\/certificate mismatch/);
  await assert.rejects(access(f.receipt),{code:'ENOENT'});
});
