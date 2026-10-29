// Shared allowlist, not a regex scrubber for arbitrary exception text.
// No message, URL, query, body, headers, identifiers or absolute paths survive.
export const DIAGNOSTIC_OPERATIONS={
  request:'リクエスト',seriesDelete:'シリーズの削除',seriesBulk:'シリーズの一括整理',
  seriesEdit:'シリーズの編集',upload:'アップロード',assetDelete:'アセットの削除',
  download:'ダウンロード',catalog:'コンテンツ一覧',account:'アカウント設定',
  client:'画面の処理',network:'サーバーへの接続'
};
export const DIAGNOSTIC_CATEGORIES={
  permission:'保存先のアクセス権または実行権限を確認してください。',
  capacity:'保存領域の空き容量または容量制限を確認してください。',
  storage:'ストレージの接続状態または読み書きを確認してください。',
  database:'データベースの制約または状態を確認してください。',
  validation:'入力内容または操作対象の最新状態を確認してください。',
  authorization:'ログイン状態とアクセス権を確認してください。',
  network:'接続先や通信状態を確認してください。',
  internal:'アプリケーション内部で処理に失敗しました。',
  client:'画面または端末の処理に失敗しました。'
};
export const MEDIA_DIAGNOSTIC_CODES=new Set('IMAGE_DECODE_FAILED IMAGE_TRUNCATED IMAGE_PROFILE_INVALID IMAGE_INVALID_DATA IMAGE_TYPE_MISMATCH IMAGE_FORMAT_UNSUPPORTED IMAGE_ANIMATED_UNSUPPORTED MEDIA_PROCESSING_TIMEOUT MEDIA_WORKER_FAILED PDF_DECODE_FAILED EPUB_DECODE_FAILED'.split(' '));
export const DIAGNOSTIC_CODES=new Set(('INTERNAL_ERROR HTTP_ERROR CLIENT_ERROR NETWORK_ERROR '+
  'EACCES EPERM EROFS ENOSPC EDQUOT EIO ENODEV ESTALE ENOENT ENOTDIR EISDIR ENOTEMPTY EBUSY EMFILE ENFILE '+
  'ETIMEDOUT ECONNREFUSED ECONNRESET ENETUNREACH EHOSTUNREACH '+
  'ERR_ACCESS_DENIED ERR_SQLITE_ERROR SQLITE_BUSY SQLITE_LOCKED SQLITE_FULL SQLITE_READONLY SQLITE_CONSTRAINT '+
  'ERR_INVALID_ARG_TYPE ERR_INVALID_ARG_VALUE ERR_OUT_OF_RANGE ERR_STREAM_PREMATURE_CLOSE ERR_STREAM_DESTROYED ABORT_ERR').split(' ').concat([...MEDIA_DIAGNOSTIC_CODES]));
export const DIAGNOSTIC_SOURCES=new Set(('accounts admin-access admin-backups admin-cleanup admin-jobs admin-reset admin analytics app-updates app '+
  'audio-art audio-publish audio-transcode audio-types backup-archive bootstrap-admin custom-thumbnails database downloads ebook-types epub '+
  'error-diagnostics error-diagnostic-schema history image-integrity index job-context job-pool jpeg-end-marker library-catalog maintenance-gate media-binary media-failure media-source media-worker media '+
  'name-integrity name-rules pending-uploads playlists processing-settings progress remember-session remote-app-update replay-eligibility replay-heatmap '+
  'resumable runtime security series-actions series server-updates shelf-management storage-move storage thumbnail-webp update-manifest upload-errors '+
  'upload-publish upload-series video-navigation video-previews video-publish video-stream video-thumbnail video-transcode video-types').split(' ').map(s=>'server/'+s+'.js'));
export const DIAGNOSTIC_SYSCALLS=new Set('access chmod chown close copyfile fsync fstat lstat mkdir open read readdir realpath rename rmdir rm stat unlink write'.split(' '));
export const DIAGNOSTIC_PERMISSIONS=new Set(['FileSystemRead','FileSystemWrite','ChildProcess','WorkerThreads']);
const types=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','AggregateError','AbortError']);
const sqliteCodes=new Set([1,5,6,7,8,10,11,13,14,18,19,20,21,23,24,25,26,27,28,100,101,275,531,787,1555,1811,2067]);
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const number=n=>Number.isInteger(n)&&n>0&&n<=1000000;
export function normalizeImageDiagnostic(value){
 if(!value||typeof value!=='object')return undefined;
 try{
 const result={};
 if(['page-validation','thumbnail'].includes(value.stage))result.stage=value.stage;
 if(['read','metadata','decode','render'].includes(value.phase))result.phase=value.phase;
 if(['jpeg','png','webp'].includes(value.format))result.format=value.format;
 for(const key of ['page','pages'])if(Number.isInteger(value[key])&&value[key]>=1&&value[key]<=1000)result[key]=value[key];
 for(const key of ['width','height'])if(Number.isInteger(value[key])&&value[key]>=1&&value[key]<=4294967295)result[key]=value[key];
 return Object.keys(result).length?result:undefined;
 }catch{return undefined;}
}
function cause(value){
  if(!value||typeof value!=='object')return null;
  const result={category:own(DIAGNOSTIC_CATEGORIES,value.category)?value.category:'internal',code:DIAGNOSTIC_CODES.has(value.code)?value.code:'INTERNAL_ERROR',type:types.has(value.type)?value.type:'Error',trace:[]};
  if(DIAGNOSTIC_SYSCALLS.has(value.syscall))result.syscall=value.syscall;
  if(DIAGNOSTIC_PERMISSIONS.has(value.permission))result.permission=value.permission;
  if(sqliteCodes.has(value.sqliteCode))result.sqliteCode=value.sqliteCode;
  if(Array.isArray(value.trace))for(const frame of value.trace.slice(0,8))if(frame&&DIAGNOSTIC_SOURCES.has(frame.source)&&number(frame.line)&&number(frame.column))result.trace.push({source:frame.source,line:frame.line,column:frame.column});
  return result;
}
export function normalizeDiagnostic(value){
  if(!value||value.schemaVersion!==1||typeof value.errorId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.errorId))return null;
  if(typeof value.occurredAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.occurredAt)||!Number.isFinite(Date.parse(value.occurredAt)))return null;
  const result={schemaVersion:1,errorId:value.errorId,occurredAt:value.occurredAt,status:Number.isInteger(value.status)&&value.status>=400&&value.status<=599?value.status:0,operation:own(DIAGNOSTIC_OPERATIONS,value.operation)?value.operation:'request',...cause(value),redacted:true};
  if(typeof value.serverVersion==='string'&&/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-beta)?$/.test(value.serverVersion))result.serverVersion=value.serverVersion;
  if(typeof value.clientVersion==='string'&&/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-beta)?$/.test(value.clientVersion))result.clientVersion=value.clientVersion;
  const image=normalizeImageDiagnostic(value.image);if(image)result.image=image;
  if(Array.isArray(value.causes))result.causes=value.causes.slice(0,2).map(cause).filter(Boolean);
  return result;
}
