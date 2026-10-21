import { createHash } from 'node:crypto';
import { transaction } from './database.js';
import { httpError } from './security.js';
import { IMAGE_BOOK_MIME } from './media.js';
import { isAudio, isTimedKind } from './audio-types.js';
import { EPUB_MIME } from './ebook-types.js';
import { replayHeatmap } from './replay-heatmap.js';

const DAY = 86400000, MAX_SESSION = 7 * DAY, BIN_MS = 10000;
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const int = maximum => ({ type: 'integer', minimum: 0, maximum });
const number = maximum => ({ type: 'number', minimum: 0, maximum });
const types = ['open','view_start','interval','ready','play','pause','seeking','seeked','ended','rate_change','buffering','page_enter','page_loading','zoom','viewport','visibility','focus','idle','close','error','loop','quality_change'];
const properties = {
  id: uuid, seq: { ...int(2147483647), minimum: 1 }, type: { enum: types }, at: int(8640000000000000), elapsedMs: int(MAX_SESSION),
  intervalMs: int(5000), visibleMs: int(5000), activeMs: int(5000), watchMs: int(5000), backgroundMs:int(5000), pipMs:int(5000), gapMs: int(MAX_SESSION),
  fromMs: number(31 * DAY), toMs: number(31 * DAY), durationMs: number(31 * DAY), page: { ...int(1000000), minimum: 1 }, previousPage: { ...int(1000000), minimum: 1 },
  backgroundPlayback:{type:'boolean'}, pictureInPicture:{type:'boolean'}, visible: { type: 'boolean' }, focused: { type: 'boolean' }, idle: { type: 'boolean' }, playing: { type: 'boolean' }, seeking: { type: 'boolean' }, buffering: { type: 'boolean' },
  rate: { type: 'number', minimum: 0.1, maximum: 16 }, muted: { type: 'boolean' }, volume: number(1), fullscreen: { type: 'boolean' },
  x: number(1), y: number(1), width: number(1), height: number(1), visibleRatio: number(1), zoom: number(20),
  viewportWidth: int(32768), viewportHeight: int(32768), droppedFrames: int(2147483647),
  selectedQuality:{type:'string',pattern:'^(auto|legacy|download|[0-9]{2,4}p)$'}, actualQuality:{type:'string',pattern:'^(unknown|legacy|download|[0-9]{2,4}p)$'},
  streamKind:{enum:['hls','mp4','download']}, bandwidthEstimate:int(10000000000),
  reason: { enum: ['heartbeat','scroll','resize','ready','page','zoom','play','pause','seeking','seeked','ratechange','buffering','ended','visibility','focus','idle','native','close','error','loop'] },
  errorCode: { enum: ['network','decode','render','load','unknown'] }
};
const canonical = event => JSON.stringify(Object.fromEntries(Object.keys(event).sort().map(key => [key, event[key]])));
const kindOf = item => item.mime_type === IMAGE_BOOK_MIME ? 'image-book' : item.mime_type === EPUB_MIME ? 'epub' : item.mime_type === 'application/pdf' ? 'pdf' : isAudio(item.mime_type) ? 'audio' : 'video';

export async function registerAnalytics(app, { db, authenticate, membership, findItem, options, adminAccess }) {
  const enabled = options.analyticsEnabled ?? process.env.ANALYTICS_ENABLED !== 'false';
  const isAdmin = adminAccess.isAdmin;
  const config = { enabled, access: 'self-detail-admin-aggregate', retentionDays: 0, sampleIntervalMs: 1000, schemaVersion: 1, minimumAggregateViewers: 5 };
  const auth = { onRequest: async req => authenticate(req) };
  app.get('/api/v1/items/:id/replay-heatmap', { ...auth, preValidation: async req => { if (Object.keys(req.query).length) throw httpError(400, '集計条件は変更できません。'); }, schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] } } }, async (req, reply) => {
    if (Object.keys(req.query).length) throw httpError(400, '集計条件は変更できません。');
    const item = findItem(req.params.id, req.user.id);
    if (kindOf(item) !== 'video') throw httpError(404, '動画が見つかりません。');
    return reply.header('Cache-Control', 'private, no-store').send(replayHeatmap(db, item, { enabled, userId: req.user.id }));
  });
  const normalize = event => ({ intervalMs: 0, visibleMs: 0, activeMs: 0, watchMs: 0, ...event });
  function validate(event, view) {
    const { intervalMs, visibleMs, activeMs, watchMs,backgroundMs=0,pipMs=0 } = event;
    if(backgroundMs+pipMs>watchMs || backgroundMs && (!event.backgroundPlayback||event.visible) || pipMs && !event.pictureInPicture || event.backgroundPlayback&&event.pictureInPicture || (backgroundMs||pipMs||event.backgroundPlayback||event.pictureInPicture)&&(!isTimedKind(view.asset_kind)||view.context!=='viewer'))throw httpError(422,'バックグラウンド・PiPの再生状態が不正です。');
    if (event.elapsedMs < intervalMs || activeMs > visibleMs || visibleMs > intervalMs || watchMs > intervalMs || watchMs > activeMs+backgroundMs+pipMs) throw httpError(422, '閲覧時間の関係が不正です。');
    if (event.type !== 'interval' && (intervalMs || visibleMs || activeMs || watchMs || backgroundMs || pipMs)) throw httpError(422, '区間以外のイベントに時間は指定できません。');
    if (event.type === 'interval' && !intervalMs) throw httpError(422, '区間の長さが必要です。');
    if (event.page !== undefined && (isTimedKind(view.asset_kind) || event.page > view.page_count)) throw httpError(422, 'ページ番号が不正です。');
    if (visibleMs && !event.visible || activeMs && (!event.focused || event.idle)) throw httpError(422, '非表示・非アクティブな時間は加算できません。');
    if (!isTimedKind(view.asset_kind)) {
      if (watchMs || event.fromMs !== undefined || event.toMs !== undefined || event.durationMs !== undefined) throw httpError(422, '本に動画・音声の再生位置は指定できません。');
      if ((visibleMs || event.type === 'page_enter' || event.type === 'view_start') && !event.page) throw httpError(422, '表示したページが必要です。');
    }
    if (watchMs) {
      const delta = event.toMs - event.fromMs;
      if (!event.playing || event.seeking || event.buffering || !Number.isFinite(delta) || delta <= 0 || delta > intervalMs * (event.rate ?? 1) * 1.5 + 300) throw httpError(422, 'シーク・停止中の区間を視聴時間には加算できません。');
    }
    if (event.type === 'view_start' && ((!event.visible || !event.focused) && !(isTimedKind(view.asset_kind)&&view.context==='viewer'&&(event.backgroundPlayback||event.pictureInPicture)) || (isTimedKind(view.asset_kind) && (!event.playing || event.buffering || event.seeking)))) throw httpError(422, '実際に表示・再生した状態が必要です。');
  }
  const insert = db.prepare(`INSERT INTO analytics_events(event_id,view_id,seq,event_type,client_at,received_at,elapsed_ms,interval_ms,visible_ms,active_ms,watch_ms,from_ms,to_ms,page_number,payload_json,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  function materialize(view, event, receivedAt) {
    db.prepare(`UPDATE analytics_views SET last_received_at=?,counted=MAX(counted,?),ended=MAX(ended,?),visible_ms=visible_ms+?,active_ms=active_ms+?,watch_ms=watch_ms+? WHERE id=?`)
      .run(receivedAt, event.type === 'view_start' ? 1 : 0, event.type === 'ended' ? 1 : 0, event.visibleMs, event.activeMs, event.watchMs, view.id);
    if (!isTimedKind(view.asset_kind) && event.page && (event.type === 'page_enter' || event.type === 'interval')) {
      db.prepare(`INSERT INTO analytics_pages VALUES(?,?,?,?,?) ON CONFLICT(view_id,page_number) DO UPDATE SET visits=visits+excluded.visits,visible_ms=visible_ms+excluded.visible_ms,active_ms=active_ms+excluded.active_ms`)
        .run(view.id, event.page, event.type === 'page_enter' ? 1 : 0, event.visibleMs, event.activeMs);
    }
    if (event.watchMs > 0) {
      const delta = event.toMs - event.fromMs;
      for (let start = Math.floor(event.fromMs / BIN_MS) * BIN_MS; start < event.toMs; start += BIN_MS) {
        const overlap = Math.min(start + BIN_MS, event.toMs) - Math.max(start, event.fromMs);
        db.prepare(`INSERT INTO analytics_video_bins VALUES(?,?,?,?) ON CONFLICT(view_id,start_ms) DO UPDATE SET watch_ms=watch_ms+excluded.watch_ms,media_ms=media_ms+excluded.media_ms`)
          .run(view.id, start, event.watchMs * overlap / delta, overlap);
      }
    }
  }
  app.post('/api/v1/analytics/events', {
    ...auth, bodyLimit: 64 * 1024,
    config: { rateLimit: options.rateLimit === false ? false : { hook: 'preHandler', max: 240, timeWindow: '1 minute', keyGenerator: req => req.user.id } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['view','events'], properties: {
      view: { type: 'object', additionalProperties: false, required: ['id','assetId','context','platform','clientVersion'], properties: {
        id: uuid, assetId: uuid, context: { enum: ['viewer','preview'] }, platform: { enum: ['web','android'] }, clientVersion: { type: 'string', maxLength: 40 }
      } },
      events: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['id','seq','type','at','elapsedMs'], properties } }
    } } }
  }, async req => {
    if (!enabled) throw httpError(403, '閲覧記録は停止しています。');
    const input = req.body.view, item = findItem(input.assetId, req.user.id), kind = kindOf(item);
    if (input.context === 'preview' && kind !== 'video') throw httpError(422, 'プレビューは動画のみです。');
    const now = Date.now();
    let accepted = 0, duplicates = 0;
    transaction(db, () => {
      let view = db.prepare('SELECT * FROM analytics_views WHERE id=?').get(input.id);
      if (view && (view.user_id !== req.user.id || view.asset_id !== item.id || view.context !== input.context || view.platform !== input.platform || view.client_version !== input.clientVersion)) throw httpError(409, '閲覧セッションが一致しません。');
      if (!view) {
        db.prepare(`INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(input.id, req.user.id, item.id, item.shelf_id, kind, item.title, item.page_count, input.context, input.platform, input.clientVersion, req.session.id,
            (req.body.events[0].at >= now - MAX_SESSION && req.body.events[0].at <= now + 300000 ? Math.min(now, req.body.events[0].at) : now) - req.body.events[0].elapsedMs, now, now);
        view = db.prepare('SELECT * FROM analytics_views WHERE id=?').get(input.id);
      }
      for (const raw of req.body.events) {
        const event = normalize(raw);
        validate(event, view);
        const payload = canonical(event), hash = createHash('sha256').update(payload).digest('hex');
        const previous = db.prepare('SELECT event_id,view_id,payload_hash FROM analytics_events WHERE event_id=? OR (view_id=? AND seq=?)').all(event.id, view.id, event.seq);
        if (previous.length) {
          if (previous.some(row => row.event_id !== event.id || row.view_id !== view.id || row.payload_hash !== hash)) throw httpError(409, '再送イベントの内容が一致しません。');
          duplicates++; continue;
        }
        if (event.type === 'interval' && db.prepare(`SELECT 1 FROM analytics_events WHERE view_id=? AND event_type='interval' AND elapsed_ms>? AND elapsed_ms-interval_ms<? LIMIT 1`).get(view.id, event.elapsedMs - event.intervalMs, event.elapsedMs)) throw httpError(422, '閲覧区間が重複しています。');
        insert.run(event.id, view.id, event.seq, event.type, event.at, now, event.elapsedMs, event.intervalMs, event.visibleMs, event.activeMs, event.watchMs, event.fromMs ?? null, event.toMs ?? null, event.page ?? null, payload, hash);
        materialize(view, event, now);
        accepted++;
      }
    });
    return { accepted, duplicates, schemaVersion: 1 };
  });

  const filters = { type: 'object', additionalProperties: false, properties: {
    from: int(8640000000000000), to: int(8640000000000000), assetId: uuid,
    context: { enum: ['viewer','preview'] }, after: int(Number.MAX_SAFE_INTEGER), limit: { type: 'integer', minimum: 1, maximum: 1000 }, format: { enum: ['json','ndjson'] }
  } };
  function scope(req) {
    const query = req.query;
    const conditions = ['v.user_id=?'], params = [req.user.id];
    for (const [field, column] of [['assetId','asset_id'],['context','context']]) {
      if (query[field]) { conditions.push(`v.${column}=?`); params.push(query[field]); }
    }
    const from = query.from ?? 0, to = query.to ?? Date.now();
    if (from > to) throw httpError(400, '期間が不正です。');
    conditions.push('v.opened_at>=? AND v.opened_at<=?'); params.push(from, to);
    return { sql: conditions.join(' AND '), params };
  }
  function summarize(req) {
    const { sql, params } = scope(req);
    const result = {
      assets: db.prepare(`SELECT v.asset_id AS assetId,v.asset_title AS title,v.asset_kind AS kind,v.context,
        COUNT(*) AS openedCount,SUM(v.counted) AS viewCount,COUNT(DISTINCT CASE WHEN v.counted=1 THEN v.user_id END) AS uniqueViewers,
        SUM(v.visible_ms) AS visibleMs,SUM(v.active_ms) AS activeMs,SUM(v.watch_ms) AS watchMs,SUM(v.ended) AS endedCount,MAX(v.last_received_at) AS lastSeenAt
        FROM analytics_views v WHERE ${sql} GROUP BY v.asset_id,v.context ORDER BY lastSeenAt DESC LIMIT 1001`).all(...params),
      pages: db.prepare(`SELECT v.asset_id AS assetId,p.page_number AS page,SUM(p.visits) AS visits,SUM(p.visible_ms) AS visibleMs,SUM(p.active_ms) AS activeMs
        FROM analytics_pages p JOIN analytics_views v ON v.id=p.view_id WHERE ${sql} GROUP BY v.asset_id,p.page_number ORDER BY v.asset_id,p.page_number LIMIT 5001`).all(...params),
      videoBins: db.prepare(`SELECT v.asset_id AS assetId,v.context,b.start_ms AS startMs,SUM(b.watch_ms) AS watchMs,SUM(b.media_ms) AS mediaMs
        FROM analytics_video_bins b JOIN analytics_views v ON v.id=b.view_id WHERE ${sql} GROUP BY v.asset_id,v.context,b.start_ms ORDER BY v.asset_id,b.start_ms LIMIT 5001`).all(...params),
      binSizeMs: BIN_MS, schemaVersion: 1, limits: { assets: 1000, pages: 5000, videoBins: 5000 }
    };
    result.truncated = result.assets.length > 1000 || result.pages.length > 5000 || result.videoBins.length > 5000;
    result.assets = result.assets.slice(0,1000); result.pages = result.pages.slice(0,5000); result.videoBins = result.videoBins.slice(0,5000);
    return result;
  }
  function events(req, reply) {
    const { sql, params } = scope(req), limit = req.query.limit ?? 500;
    const rows = db.prepare(`SELECT e.*,v.user_id,v.asset_id,v.shelf_id,v.asset_kind,v.asset_title,v.context,v.platform,v.client_version
      FROM analytics_events e JOIN analytics_views v ON v.id=e.view_id WHERE ${sql} AND e.row_id>? ORDER BY e.row_id LIMIT ?`).all(...params, req.query.after ?? 0, limit);
    const result = rows.map(row => ({ schemaVersion: 1, cursor: row.row_id, viewId: row.view_id, actorId: row.user_id, assetId: row.asset_id, shelfId: row.shelf_id,
      assetKind: row.asset_kind, assetTitle: row.asset_title, context: row.context, platform: row.platform, clientVersion: row.client_version,
      receivedAt: row.received_at, arrivalDeltaMs: row.received_at - row.client_at, event: JSON.parse(row.payload_json) }));
    const nextCursor = rows.at(-1)?.row_id ?? req.query.after ?? 0;
    if (req.query.format === 'ndjson') return reply.type('application/x-ndjson').header('X-Next-Cursor', nextCursor)
      .header('Content-Disposition', 'attachment; filename="mirea-analytics.ndjson"').send(result.map(row => JSON.stringify(row)).join('\n') + (result.length ? '\n' : ''));
    return { events: result, nextCursor, hasMore: rows.length === limit, schemaVersion: 1 };
  }
  app.get('/api/v1/analytics/me/summary', { ...auth, schema: { querystring: filters } }, async req => summarize(req));
  app.get('/api/v1/analytics/me/events', { ...auth, schema: { querystring: filters } }, async (req, reply) => events(req, reply));
  app.get('/api/v1/analytics/access', auth, async req => ({ canViewGlobal: isAdmin(req.user.id) }));

  const publicFilters = { type: 'object', additionalProperties: false, properties: { period: { enum: ['7d','30d','90d','all'] }, assetId: uuid, format: { enum: ['json','ndjson'] } } };
  const strictPublicQuery = async req => {
    if (Object.keys(req.query).some(key => !['period','assetId','format'].includes(key))) throw httpError(400, '匿名集計では個人・細かな時刻による絞り込みはできません。');
  };
  function aggregate(req, global) {
    if (global) { if (!isAdmin(req.user.id)) throw httpError(403, 'サーバー管理者のみ利用できます。'); }
    else membership(req.params.id, req.user.id, ['owner']);
    if (global && req.query.assetId) throw httpError(400, '全体集計では個別アセットを指定できません。');
    const end = Math.floor(Date.now() / DAY) * DAY;
    const period = req.query.period ?? '30d';
    const from = period === 'all' ? 0 : end - Number.parseInt(period, 10) * DAY;
    const conditions = ['v.opened_at>=? AND v.opened_at<?'], params = [from, end];
    if (!global) { conditions.push('v.shelf_id=?'); params.push(req.params.id); }
    if (req.query.assetId) { conditions.push('v.asset_id=?'); params.push(req.query.assetId); }
    const where = conditions.join(' AND ');
    const grouping = global ? 'v.asset_kind,v.context,v.platform' : 'v.asset_id,v.context';
    const dimensions = global ? 'v.asset_kind AS kind,v.context,v.platform' : 'v.asset_id AS assetId,v.asset_title AS title,v.asset_kind AS kind,v.context';
    const rows = db.prepare(`SELECT ${dimensions},COUNT(*) AS openedCount,SUM(v.counted) AS viewCount,
      COUNT(DISTINCT CASE WHEN v.counted=1 THEN v.user_id END) AS uniqueViewers,SUM(v.visible_ms) AS visibleMs,SUM(v.active_ms) AS activeMs,SUM(v.watch_ms) AS watchMs,SUM(v.ended) AS endedCount
      FROM analytics_views v WHERE ${where} GROUP BY ${grouping} HAVING COUNT(DISTINCT CASE WHEN v.counted=1 THEN v.user_id END)>=5 LIMIT 1001`).all(...params);
    const round = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ['openedCount','viewCount','uniqueViewers','endedCount','visits'].includes(key) ? Math.floor(value / 5) * 5 : ['visibleMs','activeMs','watchMs','mediaMs'].includes(key) ? Math.floor(value / 10000) * 10000 : value]));
    let pages = [], videoBins = [];
    if (!global) {
      pages = db.prepare(`SELECT v.asset_id AS assetId,p.page_number AS page,SUM(p.visits) AS visits,SUM(p.visible_ms) AS visibleMs,SUM(p.active_ms) AS activeMs
        FROM analytics_pages p JOIN analytics_views v ON v.id=p.view_id WHERE ${where} GROUP BY v.asset_id,p.page_number
        HAVING COUNT(DISTINCT CASE WHEN p.visible_ms>0 AND v.counted=1 THEN v.user_id END)>=5 LIMIT 5001`).all(...params);
      videoBins = db.prepare(`SELECT v.asset_id AS assetId,v.context,b.start_ms AS startMs,SUM(b.watch_ms) AS watchMs,SUM(b.media_ms) AS mediaMs
        FROM analytics_video_bins b JOIN analytics_views v ON v.id=b.view_id WHERE ${where} GROUP BY v.asset_id,v.context,b.start_ms
        HAVING COUNT(DISTINCT CASE WHEN v.counted=1 THEN v.user_id END)>=5 LIMIT 5001`).all(...params);
    }
    return { assets: rows.slice(0,1000).map(round), pages: pages.slice(0,5000).map(round), videoBins: videoBins.slice(0,5000).map(round),
      truncated: rows.length>1000 || pages.length>5000 || videoBins.length>5000,
      privacy: { minimumViewers: 5, countRounding: 5, timeRoundingMs: 10000, excludesToday: true, individualFilters: false },
      period: { from, to: end }, binSizeMs: BIN_MS, schemaVersion: 1 };
  }
  for (const [base, global] of [['/api/v1/shelves/:id/analytics', false], ['/api/v1/analytics/global', true]]) {
    for (const suffix of ['summary','export']) app.get(`${base}/${suffix}`, { ...auth, preValidation: strictPublicQuery, schema: { querystring: publicFilters } }, async (req, reply) => {
      const result = aggregate(req, global);
      if (suffix === 'export' || req.query.format === 'ndjson') {
        const rows = [{ type: 'metadata', privacy: result.privacy, period: result.period, truncated: result.truncated, schemaVersion: 1 }, ...result.assets.map(row => ({ type: 'asset', ...row })), ...result.pages.map(row => ({ type: 'page', ...row })), ...result.videoBins.map(row => ({ type: 'video_bin', ...row }))];
        return reply.type('application/x-ndjson').header('Content-Disposition', 'attachment; filename="mirea-anonymous-aggregate.ndjson"').send(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
      return result;
    });
  }
  // Personal raw logs have no item/user FK and no automatic expiration. Admin
  // endpoints expose only delayed, thresholded and coarsened aggregates.
  return config;
}
