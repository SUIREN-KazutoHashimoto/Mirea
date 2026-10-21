export function heatmapGeometry(value) {
  if (!['anonymous','self'].includes(value?.scope) || value.available !== true || !Array.isArray(value.points) || !value.points.length || value.points.length > 200 || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || !Number.isFinite(value.binSizeMs) || value.binSizeMs < 10000) return null;
  if (value.points.some(p => p !== null && (!Number.isFinite(p) || p < 0 || p > 1))) return null;
  if (value.points.length !== Math.ceil(value.durationMs / value.binSizeMs)) return null;
  let path = '', peak = -1;
  value.points.forEach((height, i) => {
    if (height === null) return;
    const x = i * value.binSizeMs / value.durationMs * 1000, right = Math.min(1000, (i + 1) * value.binSizeMs / value.durationMs * 1000);
    const y = 40 - height * 36;
    path += `M${x.toFixed(2)},40L${x.toFixed(2)},${y.toFixed(2)}L${right.toFixed(2)},${y.toFixed(2)}L${right.toFixed(2)},40Z`;
    if (height > 0 && (peak < 0 || height > value.points[peak])) peak = i;
  });
  return peak < 0 ? null : { path, peakMs: peak * value.binSizeMs };
}
