import { loadEnvFile } from 'node:process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadEnvironment(filename = join(PROJECT_ROOT, '.env')) {
  try { loadEnvFile(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Resolve defaults from the installation, not the caller's working directory.
// Docker supplies HOST=0.0.0.0 and DATA_DIR=/data; direct execution uses loopback
// and <installation>/data. Explicit process variables take priority over .env.
export function runtimeConfig(env = process.env, projectRoot = PROJECT_ROOT) {
  const host = (env.HOST ?? '127.0.0.1').trim();
  const portText = env.PORT ?? '3000';
  if (!host) throw new Error('HOST must not be empty');
  if (!/^\d+$/.test(portText) || !Number.isSafeInteger(Number(portText)) || Number(portText) > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const dataPath = env.DATA_DIR ?? './data';
  if (!dataPath.trim()) throw new Error('DATA_DIR must not be empty');
  return { host, port: Number(portText), dataDir: isAbsolute(dataPath) ? resolve(dataPath) : resolve(projectRoot, dataPath) };
}

export async function loadTlsOptions(env=process.env,projectRoot=PROJECT_ROOT){
  const key=env.HTTPS_KEY_FILE?.trim(),cert=env.HTTPS_CERT_FILE?.trim();
  if(!key && !cert)return undefined;
  if(!key || !cert)throw new Error('HTTPS_KEY_FILE and HTTPS_CERT_FILE must be configured together');
  const locate=value=>isAbsolute(value)?value:resolve(projectRoot,value);
  // Fail before opening the application database; never fall back to HTTP on a TLS error.
  return {key:await readFile(locate(key)),cert:await readFile(locate(cert)),minVersion:'TLSv1.2'};
}
