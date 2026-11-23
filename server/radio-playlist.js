import {createHash} from 'node:crypto';
import {httpError} from './security.js';

export const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TRACKS = 200;
export const radioPlaylistId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const unavailable = () => httpError(404, 'Radio program unavailable');

function duration(metadata) {
  try {
    const seconds = JSON.parse(metadata)?.duration;
    const ms = Math.round(seconds * 1000);
    if (typeof seconds === 'number' && Number.isSafeInteger(ms) && ms >= 1000 && ms <= 600_000) return ms;
  } catch { /* Unusable canonical metadata is not scheduled. */ }
  return null;
}

export function prepareSavedRadioPlan(db) {
  const playlistQuery = db.prepare('SELECT user_id, revision FROM playlists WHERE id=?');
  const trackQuery = db.prepare(`SELECT i.id, i.title, i.size, i.shelf_id, aa.metadata_json FROM playlist_items pi
    JOIN items i ON i.id=pi.asset_id
    JOIN shelves s ON s.id=i.shelf_id AND s.private=0
    JOIN memberships m ON m.shelf_id=i.shelf_id AND m.user_id=?
    JOIN audio_assets aa ON aa.item_id=i.id
    LEFT JOIN media_ingest mi ON mi.asset_id=i.id
    WHERE pi.playlist_id=? AND i.mime_type='audio/mp4' AND i.size BETWEEN 1 AND ?
      AND (mi.asset_id IS NULL OR mi.canonical_ready=1)
    ORDER BY pi.position LIMIT ?`);
  return playlistId => {
    const playlist = playlistQuery.get(playlistId);
    if (!playlist) return null;
    const rows = trackQuery.all(playlist.user_id, playlistId, MAX_BYTES, MAX_TRACKS + 1);
    if (rows.length > MAX_TRACKS) return null;
    const tracks = rows
      .filter(row => radioPlaylistId.test(row.id))
      .map(row => ({id: row.id, title: row.title, size: row.size, shelfId: row.shelf_id, durationMs: duration(row.metadata_json)}))
      .filter(track => track.durationMs !== null);
    if (!tracks.length) return null;
    return {owner: playlist.user_id, revision: playlist.revision, tracks};
  };
}

export function loadSavedRadio({db, openFile, playlistId, name, epoch, now}) {
  const preparePlan = prepareSavedRadioPlan(db);
  const readPlan = () => preparePlan(playlistId);
  const plan = readPlan();
  const snapshot = JSON.stringify(plan);
  const generation = createHash('sha256').update(JSON.stringify([playlistId, epoch, plan])).digest('hex').slice(0, 24);
  const byUrl = new Map();
  let cycle = 0;
  const tracks = (plan?.tracks ?? []).map(track => {
    const key = generation + '-' + track.id;
    const scheduled = {...track, key, start: cycle};
    cycle += track.durationMs;
    byUrl.set(key, scheduled);
    return scheduled;
  });
  let changed = false;
  function authorize(user) {
    if (!plan || user?.id !== plan.owner || changed) throw unavailable();
    if (JSON.stringify(readPlan()) !== snapshot) {
      changed = true;
      throw unavailable();
    }
  }
  function authorizeFile(id, user) {
    authorize(user);
    if (!byUrl.has(id)) throw unavailable();
  }
  return {
    available(user) {
      try { authorize(user); return true; }
      catch (error) { if (error.statusCode === 404) return false; throw error; }
    },
    current(user) {
      authorize(user);
      const serverTime = now(), offset = ((serverTime - epoch) % cycle + cycle) % cycle;
      const track = tracks.find(item => offset < item.start + item.durationMs);
      return {station: name, title: track.title, serverTime, startTime: serverTime - offset + track.start,
        durationMs: track.durationMs, mediaUrl: `/api/v1/radio/tracks/${track.key}/content`};
    },
    authorizeFile,
    async file(id, user) {
      authorizeFile(id, user);
      const track = byUrl.get(id);
      let opened;
      try { opened = await openFile(track.id, MAX_BYTES); }
      catch { throw unavailable(); }
      if (opened.size !== track.size) { await opened.file.close(); throw unavailable(); }
      return {...opened, mimeType: 'audio/mp4'};
    }
  };
}
