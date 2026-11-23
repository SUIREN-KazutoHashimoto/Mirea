import {open, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {httpError} from './security.js';
import {loadSavedRadio, radioPlaylistId} from './radio-playlist.js';

const MAX_BYTES = 16 * 1024 * 1024;
const mediaName = /^[a-z0-9][a-z0-9._-]{0,99}\.mp3$/i;
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;

export async function openStationFile(root, name, maxBytes, exact = false) {
  const path = await realpath(join(root, name));
  if (dirname(path) !== root || (exact && path !== join(root, name))) throw new Error('Radio file must be inside the station directory');
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new Error('Invalid radio file size or type');
    return {file, size: info.size};
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function loadRadio(directory, now = Date.now, {db, uploadDir} = {}) {
  if (!directory) return null;
  const root = await realpath(resolve(directory));
  const manifest = await openStationFile(root, 'station.json', 64 * 1024);
  let config;
  try { config = JSON.parse(await manifest.file.readFile('utf8')); }
  finally { await manifest.file.close(); }
  const saved = config?.playlistId !== undefined;
  if (!label(config?.name) || (saved
    ? typeof config.playlistId !== 'string' || !radioPlaylistId.test(config.playlistId) || config.tracks !== undefined || !db || !uploadDir
    : !Array.isArray(config.tracks) || config.tracks.length < 1 || config.tracks.length > 200)) {
    throw new Error('Invalid radio station metadata');
  }
  const epoch = Date.parse(config.epoch);
  if (typeof config.epoch !== 'string' || !config.epoch.endsWith('Z') || !Number.isSafeInteger(epoch) || epoch > now()) {
    throw new Error('Radio station requires a UTC epoch at or before startup');
  }
  if (saved) {
    const uploads = await realpath(uploadDir);
    return loadSavedRadio({db, playlistId: config.playlistId, name: config.name, epoch, now,
      openFile: (name, maxBytes) => openStationFile(uploads, name, maxBytes, true)});
  }
  const tracks = [];
  let cycle = 0;
  for (const track of config.tracks) {
    if (!label(track?.title) || typeof track.file !== 'string' || !mediaName.test(track.file) ||
        !Number.isSafeInteger(track.durationMs) || track.durationMs < 1000 || track.durationMs > 600_000) {
      throw new Error('Invalid radio track metadata');
    }
    await (await openStationFile(root, track.file, MAX_BYTES)).file.close();
    tracks.push({...track, start: cycle, id: tracks.length});
    cycle += track.durationMs;
  }
  return {
    current() {
      const serverTime = now();
      const offset = ((serverTime - epoch) % cycle + cycle) % cycle;
      const track = tracks.find(item => offset < item.start + item.durationMs);
      return {station: config.name, title: track.title, serverTime, startTime: serverTime - offset + track.start,
        durationMs: track.durationMs, mediaUrl: `/api/v1/radio/tracks/${track.id}/content`};
    },
    async file(id) {
      if (!/^(0|[1-9][0-9]{0,2})$/.test(id) || !tracks[id]) throw httpError(404, '音源が見つかりません。');
      try { return await openStationFile(root, tracks[id].file, MAX_BYTES); }
      catch { throw httpError(404, '音源が見つかりません。'); }
    }
  };
}

export function registerRadio(app, {radio, authenticate}) {
  const auth = {preHandler: async req => authenticate(req)};
  app.get('/api/v1/radio/now', auth, async req => {
    if (!radio) throw httpError(404, 'ラジオは設定されていません。');
    return radio.current(req.user);
  });
  app.get('/api/v1/radio/tracks/:id/content', auth, async (req, reply) => {
    if (!radio) throw httpError(404, 'ラジオは設定されていません。');
    const {file, size, mimeType = 'audio/mpeg'} = await radio.file(req.params.id, req.user);
    try {
      authenticate(req);
      radio.authorizeFile?.(req.params.id, req.user);
    } catch (error) { await file.close(); throw error; }
    reply.type(mimeType).header('Content-Length', size);
    if (req.method === 'HEAD') { await file.close(); return reply.send(); }
    return reply.send(file.createReadStream({start: 0, end: size - 1}));
  });
}
