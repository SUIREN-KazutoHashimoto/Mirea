// Never expose host paths, decoder stderr or credentials to clients. Retrying
// another file cannot repair a full/read-only/unwritable storage volume.
export function uploadErrorMessage(error) {
  if (error.statusCode >= 400 && error.statusCode < 500 || error.statusCode===503) return error.message;
  const code=error.code??error.cause?.code;
  if (['ENOSPC','EDQUOT','SQLITE_FULL'].includes(code)) return 'サーバーの保存領域または容量制限に空きがありません。管理者が空き容量を確認してから再試行してください。';
  if (['EACCES','EPERM','EROFS'].includes(code)) return 'サーバーの保存領域へ書き込めません。管理者がマウントと書き込み権限を確認してから再試行してください。';
  if (['EIO','ENODEV','ESTALE'].includes(code)) return 'サーバーの保存領域にアクセスできません。管理者がストレージの接続状態を確認してください。';
  return 'メディアの保存に失敗しました。管理者がジョブのエラーとサーバーログを確認してください。';
}
