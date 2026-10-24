import {lstat,realpath,readdir,readFile,open} from 'node:fs/promises';
import {createHash,X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import {join} from 'node:path';

const requireThat=(ok,message)=>{if(!ok)throw Error('TrueNAS preflight: '+message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const names=async path=>JSON.stringify((await readdir(path)).sort());
const pin=(env,key)=>{const value=env[key];requireThat(/^[A-Fa-f0-9]{64}$/.test(value??''),key+' must be a SHA-256 hex fingerprint');return value.toUpperCase();};

// Shared implementation is tested with isolated Linux fixtures, never live data.
export async function preflightTrueNas({env=process.env,data='/data',media='/media',identity={uid:process.getuid?.(),gid:process.getgid?.()}}={}) {
  const {uid,gid}=identity;
  requireThat(Number.isInteger(uid)&&uid>0&&Number.isInteger(gid)&&gid>0,'non-root runtime identity required');
  requireThat(env.DATA_DIR===data&&env.MEDIA_DIR===media,'separate DATA_DIR and MEDIA_DIR required');
  const group=Number(env.MIREA_STORAGE_GROUP_ID);
  requireThat(/^\d+$/.test(env.MIREA_STORAGE_GROUP_ID??'')&&Number.isSafeInteger(group)&&group>0,'MIREA_STORAGE_GROUP_ID required');
  const installation=env.MIREA_INSTALL_ID;
  requireThat(/^[a-zA-Z0-9-]{16,80}$/.test(installation??''),'stable MIREA_INSTALL_ID required');
  async function directory(path,expectedGroup=gid,mode) {
    const s=await lstat(path);
    requireThat(s.isDirectory()&&!s.isSymbolicLink()&&await realpath(path)===path,'directory must not contain symlinks: '+path);
    requireThat(s.uid===uid&&s.gid===expectedGroup,'directory ownership mismatch: '+path);
    requireThat((s.mode&0o007)===0&&(mode===undefined||(s.mode&0o777)===mode),'directory permissions mismatch: '+path);
    return s;
  }
  const a=await directory(data,group),b=await directory(media,group);
  requireThat(a.dev!==b.dev||a.ino!==b.ino,'storage roots must differ');
  for(const path of [join(data,'keys'),join(data,'keys/tls')])await directory(path,gid,0o700);
  const tls=join(data,'keys/tls');
  for(const [name,mode] of [['server-key.pem',0o600],['server-chain.pem',0o644],['suiren-root-ca.pem',0o644]]) {
    const s=await lstat(join(tls,name));
    requireThat(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===uid&&s.gid===gid&&(s.mode&0o777)===mode,'TLS file type/ownership/permissions mismatch: '+name);
  }
  requireThat(env.HTTPS_KEY_FILE===join(tls,'server-key.pem')&&env.HTTPS_CERT_FILE===join(tls,'server-chain.pem')&&env.HEALTHCHECK_CA_FILE===join(tls,'suiren-root-ca.pem'),'TLS paths must use the protected certificate directory');
  const hostname=env.HEALTHCHECK_TLS_SERVER_NAME,ip=env.MIREA_TLS_IP;
  requireThat(typeof hostname==='string'&&hostname.length>0&&typeof ip==='string'&&ip.length>0,'certificate DNS name and IP required');
  const expectedRoot=pin(env,'MIREA_TLS_ROOT_SHA256'),expectedLeaf=pin(env,'MIREA_TLS_LEAF_SHA256'),expectedSpki=pin(env,'MIREA_TLS_SPKI_SHA256');
  const cert=await readFile(join(tls,'server-chain.pem'),'utf8'),blocks=cert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)??[];
  requireThat(blocks.length===2,'expected leaf plus root chain');
  const leaf=new X509Certificate(blocks[0]),root=new X509Certificate(await readFile(join(tls,'suiren-root-ca.pem')));
  requireThat(hash(root.raw)===expectedRoot&&hash(new X509Certificate(blocks[1]).raw)===expectedRoot&&hash(leaf.raw)===expectedLeaf,'certificate fingerprint mismatch');
  requireThat(root.ca&&root.verify(root.publicKey)&&leaf.checkIssued(root)&&leaf.verify(root.publicKey)&&!leaf.ca,'invalid certificate signature or basic constraints');
  requireThat(leaf.checkHost(hostname)===hostname&&leaf.checkIP(ip)===ip,'certificate DNS/IP mismatch');
  requireThat(leaf.keyUsage?.length===1&&leaf.keyUsage[0]==='1.3.6.1.5.5.7.3.1','server-auth-only certificate required');
  for(const c of [leaf,root])requireThat(Date.now()>=Date.parse(c.validFrom)&&Date.now()<Date.parse(c.validTo),'certificate outside validity period');
  const key=await readFile(join(tls,'server-key.pem'));
  const spki=createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'});
  requireThat(hash(spki)===expectedSpki&&hash(leaf.publicKey.export({type:'spki',format:'der'}))===expectedSpki,'key/certificate mismatch');
  createSecureContext({key,cert,minVersion:'TLSv1.2'});
  const receipt=join(data,'.truenas-mirea-bootstrap.json');
  let existing;
  try{existing=await lstat(receipt);}catch(error){if(error.code!=='ENOENT')throw error;}
  const expected={schemaVersion:2,installation,uid,gid,storageGroup:group,root:expectedRoot,leaf:expectedLeaf,spki:expectedSpki,hostname,ip};
  if(existing) {
    requireThat(existing.isFile()&&!existing.isSymbolicLink()&&existing.nlink===1&&existing.uid===uid&&(existing.mode&0o777)===0o600,'invalid installation receipt');
    const old=JSON.parse(await readFile(receipt,'utf8'));
    requireThat(Object.entries(expected).every(([k,v])=>old[k]===v),'installation receipt mismatch; back up and review before changing configuration');
  } else {
    requireThat(await names(data)==='["keys"]','existing data detected; full backup and review required');
    requireThat(await names(join(data,'keys'))==='["tls"]','existing encryption keys detected; full backup and review required');
    requireThat(await names(tls)==='["server-chain.pem","server-key.pem","suiren-root-ca.pem"]','unexpected TLS files');
    requireThat(await names(media)==='[]','existing media detected; full backup and review required');
    const file=await open(receipt,'wx',0o600);
    try{await file.writeFile(JSON.stringify({...expected,createdAt:new Date().toISOString()})+'\n');await file.sync();}finally{await file.close();}
  }
  const result={event:'truenas_preflight_passed',uid,gid,freshInstall:!existing,tlsPinsVerified:true,separateDataAndMedia:true};
  console.log(JSON.stringify(result));
  return result;
}
