export function validShellManifest(manifest){
  return /^[0-9a-f]{64}$/.test(manifest?.version??'')&&Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=2000&&manifest.files.every(path=>typeof path==='string'&&/^\/(?:index\.html|favicon\.svg|brand\/orbit-(?:mark|mark-inverse|icon)\.svg|download-sw\.js|assets\/[A-Za-z0-9_.-]+|pdf-assets\/[A-Za-z0-9_./-]+)$/.test(path)&&!path.includes('..'));
}
