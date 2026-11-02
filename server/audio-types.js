// Input MIME aliases used by browsers/Android. Stored playback is always AAC/M4A.
export const AUDIO_EXTENSIONS = {
  mp3:'audio/mpeg', m4a:'audio/mp4', m4b:'audio/mp4', aac:'audio/aac',
  wav:'audio/wav', flac:'audio/flac', ogg:'audio/ogg', oga:'audio/ogg',
  opus:'audio/ogg', aif:'audio/aiff', aiff:'audio/aiff', wma:'audio/x-ms-wma', weba:'audio/webm'
};
export const AUDIO_TYPES = [...new Set([...Object.values(AUDIO_EXTENSIONS),
  'audio/mp3','audio/x-m4a','audio/x-wav','audio/wave','audio/x-flac','audio/x-aiff','audio/opus'])];
export const isAudio = mime => AUDIO_TYPES.includes(mime);
export const isTimedMime = mime => mime.startsWith('video/') || isAudio(mime);
export const isTimedKind = kind => kind === 'video' || kind === 'audio';
