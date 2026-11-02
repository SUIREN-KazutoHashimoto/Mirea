// The bundled Linux static build crashes on MPEG-TS. Use the distribution's
// maintained, dynamically linked pair on Linux; retain bundled Windows/macOS.
export function mediaBinary(name, bundled, platform = process.platform, env = process.env) {
  if (!['ffmpeg','ffprobe'].includes(name)) throw new Error('Unknown media executable');
  return env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'] || (platform === 'linux' ? `/usr/bin/${name}` : bundled);
}
