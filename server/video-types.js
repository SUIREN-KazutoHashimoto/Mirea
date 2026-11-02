// Browser MIME values vary by OS. The demuxer/probe, not this declaration,
// decides whether an uploaded file is a supported video.
export const VIDEO_EXTENSIONS = {
  mp4:'video/mp4', m4v:'video/mp4', mov:'video/quicktime', mkv:'video/x-matroska',
  webm:'video/webm', avi:'video/x-msvideo', wmv:'video/x-ms-wmv', asf:'video/x-ms-asf',
  mpg:'video/mpeg', mpeg:'video/mpeg', ts:'video/mp2t', mts:'video/mp2t', m2ts:'video/mp2t', flv:'video/x-flv'
};
export const VIDEO_TYPES = [...new Set(Object.values(VIDEO_EXTENSIONS))];
export const isVideo = mime => VIDEO_TYPES.includes(mime);
