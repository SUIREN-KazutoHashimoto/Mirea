import { createPublicKey, verify, sign } from 'node:crypto';

export const ANDROID_PACKAGE = 'com.suiren.mirea';
export const MAX_APK_BYTES = 512 * 1024 * 1024;
const fields = ['schemaVersion','packageName','versionCode','versionName','apkUrl','sha256','signerSha256','size','minSdk','issuedAt','expiresAt'].sort();
const fail = () => { throw new Error('Invalid or expired signed Android update'); };
export function validateUpdatePayload(p, now = Date.now()) {
  if (!p || Array.isArray(p) || Object.keys(p).sort().join() !== fields.join()) fail();
  for (const name of ['schemaVersion','versionCode','size','minSdk','issuedAt','expiresAt']) if (!Number.isSafeInteger(p[name])) fail();
  for (const name of ['packageName','versionName','apkUrl','sha256','signerSha256']) if (typeof p[name] !== 'string') fail();
  if (p.schemaVersion !== 1 || p.packageName !== ANDROID_PACKAGE || p.versionCode < 1 || p.versionCode > 2147483647 ||
      !/^[A-Za-z0-9._+\-]{1,64}$/.test(p.versionName) || p.size < 1 || p.size > MAX_APK_BYTES || p.minSdk < 29 || p.minSdk > 100 ||
      !/^[a-f0-9]{64}$/.test(p.sha256) || !/^[a-f0-9]{64}$/.test(p.signerSha256) || p.issuedAt < 0 || p.issuedAt > now + 300000 ||
      p.expiresAt <= now || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 7 * 86400000) fail();
  let url;
  try { url = new URL(p.apkUrl); } catch { fail(); }
  if (!p.apkUrl.startsWith('https://') || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.port === '0') fail();
  return p;
}
function base64(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) fail();
  return bytes;
}
export function verifyUpdateEnvelope(raw, publicKey, now = Date.now()) {
  if (Buffer.byteLength(raw) > 65536) fail();
  const envelope = JSON.parse(raw);
  if (!envelope || Array.isArray(envelope) || Object.keys(envelope).sort().join() !== 'payload,signature') fail();
  const payload = base64(envelope.payload, 32768), signature = base64(envelope.signature, 80);
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1' || !verify('sha256', payload, key, signature)) fail();
  return validateUpdatePayload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)), now);
}
export function signUpdateEnvelope(payload, privateKey, now = Date.now()) {
  validateUpdatePayload(payload, now);
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = JSON.stringify({ payload: bytes.toString('base64'), signature: sign('sha256', bytes, privateKey).toString('base64') });
  verifyUpdateEnvelope(envelope, createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), now);
  return envelope;
}
