// Viewer-facing aggregates only. Never expose sessions, identities or raw counts.
const DAY = 86400000, MIN_VIEWERS = 5, BASE_BIN = 10000, MAX_POINTS = 200;
export function replayHeatmap(db, item, { enabled = true, now = Date.now(), userId } = {}) {
  const cutoff = Math.floor(now / DAY) * DAY;
  const empty = { schemaVersion: 1, scope: 'anonymous', available: false, points: [], privacy: { minimumViewers: MIN_VIEWERS, excludesToday: true }, asOf: cutoff };
  if (!enabled) return empty;
  let metadata;
  try { metadata = JSON.parse(db.prepare('SELECT metadata_json FROM video_assets WHERE item_id=?').get(item.id)?.metadata_json ?? 'null'); } catch { return empty; }
  const durationMs = Math.round(Number(metadata?.duration) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 31 * DAY) return empty;
  const binSizeMs = Math.max(BASE_BIN, Math.ceil(durationMs / MAX_POINTS / BASE_BIN) * BASE_BIN);
  // Exclude entire sessions still receiving events today. Per-bin thresholds
  // stop a popular asset from revealing a single viewer's unusual seek position.
  const rows = db.prepare(`SELECT CAST(b.start_ms / ? AS INTEGER) AS bucket, SUM(b.media_ms) AS mediaMs
    FROM analytics_video_bins b JOIN analytics_views v ON v.id=b.view_id
    WHERE v.asset_id=? AND v.shelf_id=? AND v.asset_kind='video' AND v.context='viewer' AND v.counted=1
      AND v.opened_at<? AND v.last_received_at<? AND b.start_ms>=0 AND b.start_ms<? AND b.media_ms>0
    GROUP BY bucket HAVING COUNT(DISTINCT v.user_id)>=? ORDER BY bucket LIMIT 200`)
    .all(binSizeMs, item.id, item.shelf_id, cutoff, cutoff, durationMs, MIN_VIEWERS);
  // Coarsen media-axis coverage before normalization: a 2x pass has the same
  // weight as a 1x pass; pauses, jumps and previews have no media-axis coverage.
  const points = Array.from({ length: Math.ceil(durationMs / binSizeMs) }, () => null);
  for (const row of rows) {
    const width = Math.min(binSizeMs, durationMs - row.bucket * binSizeMs);
    if (row.bucket >= 0 && row.bucket < points.length) points[row.bucket] = Math.floor(row.mediaMs / width / 5) * 5;
  }
  const peak = Math.max(0, ...points.filter(value => value !== null));
  if (!peak) {
    if (!userId) return empty;
    // Explicit owner-approved fallback: own sessions only, never a small group.
    // It is deliberately a separate scope and never fills anonymous gaps.
    const own = db.prepare(`SELECT CAST(b.start_ms / ? AS INTEGER) AS bucket, SUM(b.media_ms) AS mediaMs
      FROM analytics_video_bins b JOIN analytics_views v ON v.id=b.view_id
      WHERE v.user_id=? AND v.asset_id=? AND v.shelf_id=? AND v.asset_kind='video' AND v.context='viewer' AND v.counted=1
        AND b.start_ms>=0 AND b.start_ms<? AND b.media_ms>0 GROUP BY bucket ORDER BY bucket LIMIT 200`)
      .all(binSizeMs, userId, item.id, item.shelf_id, durationMs);
    const personal = points.map(() => null);
    for (const row of own) if (row.bucket >= 0 && row.bucket < personal.length) personal[row.bucket] = row.mediaMs / Math.min(binSizeMs, durationMs - row.bucket * binSizeMs);
    const ownPeak = Math.max(0, ...personal.filter(value => value !== null));
    if (!ownPeak) return empty;
    return { schemaVersion: 1, scope: 'self', available: true, durationMs, binSizeMs, points: personal.map(value => value === null ? null : Math.round(value / ownPeak * 20) / 20), privacy: { minimumViewers: 1, excludesToday: false } };
  }
  return { ...empty, available: true, durationMs, binSizeMs,
    points: points.map(value => value === null ? null : Math.round(value / peak * 20) / 20) };
}
