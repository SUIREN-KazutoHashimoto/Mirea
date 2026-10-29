# API v1

基点は `/api/v1`。認証が必要なAPIは `Authorization: Bearer <token>` を送ります。通常の本文はJSON、分割データは `application/octet-stream`、旧アップロードはmultipartです。エラーは `{ "error": "説明" }`。IDはサーバーが発行するUUIDです。

| メソッド | パス | 内容・必要権限 |
| --- | --- | --- |
| GET | `/config` | 登録可否・各上限・`uploadChunkBytes`・`uploadSessionHours`（認証不要） |
| POST | `/auth/register` | `{name,email,password}` → `{user,token,expiresAt}`、201 |
| POST | `/auth/login` | `{email,password}` → `{user,token,expiresAt}` |
| GET | `/auth/me` | 現在の `{user}` |
| POST | `/auth/logout` | 現セッションと紐付くチケットを失効、204 |
| GET | `/shelves` | 自分が所属する `{shelves:[…]}`（自分のrole・件数付き） |
| POST | `/shelves` | `{name,description?}`、本棚作成者を管理者にする、201 `{id}` |
| GET | `/shelves/:id/items` | 所属必須。`{shelf,series:[…],items:[…]}`。itemにシリーズ情報／本人の続き位置 |
| GET / POST | `/shelves/:id/series` | 所属者は一覧、管理者／編集者はシリーズ作成 |
| GET / PUT / DELETE | `/series/:id` | 所属者は順序付き詳細、管理者／編集者はrevision付き編集／シリーズだけの削除 |
| GET | `/items/:id/series` | 所属必須。現在のシリーズ・順序付きアセット一覧・currentIndex |
| POST | `/shelves/:id/items` | 管理者／編集者。multipart `title` と `file`（複数画像可）、201 `{item}` |
| POST | `/shelves/:id/uploads` | 管理者／編集者。分割アップロード開始、201 |
| GET | `/uploads/:id` | 開始した本人かつ管理者／編集者。受信状況・生成状態・完成item |
| PUT | `/uploads/:id/files/:fileIndex/parts/:partIndex` | 分割バイナリ送信。0始まり、SHA-256必須、204 |
| POST | `/uploads/:id/complete` | 全分割受信後に非同期生成を開始、202。完成済みは200 |
| DELETE | `/uploads/:id` | 受信・処理中の取消、204。保存完了後のitemは消さない |
| GET / HEAD | `/items/:id/thumbnail` | 所属必須。実メディアから生成したJPEGサムネイル |
| POST | `/items/:id/preview` | 所属必須。動画用の軽量クリップを必要時に生成、処理中202・それ以外200 |
| GET | `/items/:id/preview` | 所属必須。プレビューの生成状況を確認 |
| GET / HEAD | `/items/:id/preview/content` | Bearerと所属必須。生成済みMP4（最大6秒・音声なし・2 MiB以下）、Range対応 |
| GET | `/items/:id/pages` | 所属必須。画像の本のページ一覧・サイズ・配信URL |
| GET / HEAD | `/items/:id/pages/:number/content` | 所属必須。画像の本の1始まりのページ原画像 |
| GET | `/shelves/:id/members` | 管理者。`{members:[{id,name,email,role}]}` |
| POST | `/shelves/:id/members` | 管理者。`{email,role}`、既存ユーザーを追加、201 `{id}` |
| PATCH | `/shelves/:id/members/:userId` | 管理者。`{role}`（editor / viewer）、204 |
| DELETE | `/shelves/:id/members/:userId` | 管理者。自分以外のメンバーの共有解除、204 |
| DELETE | `/items/:id` | 管理者／編集者。ファイル削除、204 |
| POST | `/items/:id/playback-ticket` | 所属必須。`{url,expiresAt}` を返す |
| GET / HEAD | `/items/:id/content` | Bearerまたは `?ticket=…` で取得。Range対応 |
| GET | `/items/:id/progress` | 本人の再開位置。現在の所属必須。未保存はnull |
| PUT | `/items/:id/progress` | 本人の再開位置をrevision検査付きで更新。2 KiBまで |
| POST | `/items/:id/download` | 本人用の暗号化ダウンロード登録。鍵なし |
| GET | `/downloads/:id/files/:file/parts/:part` | 暗号化分割データ。現在の所属・本人の登録必須 |
| POST | `/downloads/:id/open` | オンライン認可で最長7日の閲覧許可と鍵を発行。端末では暗号化保護して保存 |
| POST | `/analytics/events` | 現在閲覧できるアセットの本人イベント。64 KiB・50件まで |
| GET | `/analytics/access` | 本人が全体匿名集計を見られるか |
| GET | `/analytics/me/summary` | 本人だけの詳細集計 |
| GET | `/analytics/me/events` | 本人だけの生ログ。カーソル付きJSON／NDJSON |
| GET | `/shelves/:id/analytics/summary`・`/export` | 本棚管理者の匿名集計。個人別ログは不可 |
| GET | `/analytics/global/summary`・`/export` | 指定サーバー管理者の全体匿名集計。個人別ログは不可 |

ヘルスチェックは `GET /api/health`。パスワードは12〜128文字、名前は80文字、本棚名は100文字、説明は500文字、コンテンツ名は200文字が上限です。登録／ログインは接続元IP当たり毎分10回までです。本棚の未所属者には404を返し、存在を明かしません。所属しているが権限不足の場合は403、未認証は401です。

閲覧記録のイベント・指標定義、自己履歴のカーソル取得、管理者向けの少人数抑制・丸め処理は [閲覧記録仕様](analytics.md) を参照してください。`GET /config` の `analytics` に収集可否・無期限保存（retentionDays:0）・権限方針・約1秒の計測間隔・匿名集計の5人閾値を含みます。

シリーズの作成・順番／巻話ラベルの更新・削除と競合時の扱いは [シリーズ仕様](series.md) を参照してください。シリーズ経由でも本人以外の進行度を返しません。

## 分割アップロード（Web／Androidの標準経路）

1. `POST /shelves/:id/uploads` に `{title,retainOriginal:true,files:[{filename,mime,size}]}` を送ります。retainOriginalの省略時はtrueです。PDF・動画・音声は1件、画像本はページ順の画像だけを指定します。合計サイズ・形式・ページ数の上限は旧APIと同じです。
2. 応答は `{id,state:"uploading",chunkSize,expiresAt,receivedBytes,files}`。ファイルごとの `receivedParts` は受信済み番号、`receivedHashes` は番号をキーとするSHA-256です。分割サイズはセッションごとに固定されます。
3. `file.slice(partIndex*chunkSize,(partIndex+1)*chunkSize)` をPUTします。Content-Typeは `application/octet-stream`、`X-Chunk-SHA256` はその分割全体の小文字16進64桁です。最後の分割を除き、長さは必ず `chunkSize` です。再送は同じハッシュ・長さなら204、内容が異なる場合は409、ハッシュ不一致は422です。
4. `POST /uploads/:id/complete` は202で直ちに応答します。結合・画像検査・サムネイル生成は別ジョブで行います。`GET /uploads/:id` を1.5秒程度の間隔で確認します。`state` は uploading / processing / complete / failed / cancelled、失敗時は `error`、完成時は `item` が返ります。未受信がある場合のcompleteは409です。
5. 受信状況はDBとディスクに保持します。再試行はGETで受信済み番号を取得し、ローカル側のハッシュも一致した部分だけをスキップしてください。Web UIはこれを実行します。処理中にサーバープロセスが終了した場合は、次回起動時に受信済みデータから再処理します。

有効期限は開始から24時間、同時に受信・処理できるアップロードはアカウント当たり3件です。期限切れは410（回収済みは404）。通信失敗時のデータは期限まで保持し、明示的なDELETEは取り消します。開始応答を受け取れずID不明になったセッションも期限後に回収します。各PUT・状況取得・complete・処理中・公開直前に認証／所属権限を検査します。開始したセッションでログアウトすると処理中ジョブは公開されません。生成失敗はステータスの `failed` で通知され、complete自体のHTTPエラーとは別です。

`UPLOAD_CHUNK_BYTES` の標準値は8 MiB、設定範囲は64 KiB〜16 MiBです。リバースプロキシもそのサイズのPUTと `X-Chunk-SHA256` ヘッダーを許可してください。ブラウザUIは分割ごとに最大3回再送し、解決しない通信障害は同じファイルで再試行できます。クライアントで動画全体をバッファには展開しません。

## 従来のmultipart API（互換・直接接続向け）

このAPIは1リクエストで全量送信し、生成完了まで待ちます。Cloudflare越しの大容量アップロードには使わないでください。新しいWeb／Android UIは上の分割APIを使用します。

例:

```js
const form = new FormData();
form.append('title', '読みたい本');
form.append('file', selectedFile);
const response = await fetch(`${server}/api/v1/shelves/${shelfId}/items`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
});
```

FormDataではContent-Typeを手動指定しません。PDF (`application/pdf`)、MP4 (`video/mp4`)、WebM (`video/webm`) は1リクエストに1ファイルを送ります。JPEG (`image/jpeg`)・PNG (`image/png`)・WebP (`image/webp`) は同じ `file` フィールドを繰り返して送り、1リクエストを1冊として扱います。PDF・動画・画像の混在は拒否します。

```js
// orderedImagesは画面で確認・並べ替えたページ順。
const form = new FormData();
form.append('title', '画像から作った本');
for (const image of orderedImages) form.append('file', image);
```

画像の本は送信順をページ順として固定し、サーバーでは並べ替えません。1枚から1,000枚まで、画像1枚100 MiB・4,000万画素以下、全画像の合計は `maxUploadBytes` 以下です。全ページをデコードして検査した上で、元のJPEG・PNG・WebPを再圧縮せず保持します。ページの配信には元のMIMEを使い、返す寸法はEXIFの向きを反映した表示寸法です。動くWebPなどは受け付けません。

`item` には `kind`（pdf / video / image-book）、`pageCount`、`thumbnailUrl` を含みます。画像の本の `mimeType` は `application/vnd.mirea.image-book`。サムネイルも各ページもBearer認証が必要です。Webでは認証付きfetchからBlob URLを作って表示します。本棚の共有解除後はサムネイル・ページ一覧・各ページすべての新規取得を拒否します。画像の本は `/content` と動画用チケットでは取得できません。

サムネイル生成・画像デコードの失敗は422で、登録は行いません。FFmpeg自体が利用できない場合は503です。PDF・動画のサムネイルは長辺480〜720px以内、画像の本は先頭ページを480×720px以内に縮小したJPEGです。

動画チケットのURLは指定した1コンテンツだけに有効です。クライアントやリバースプロキシのログにチケットを記録しないでください。APIサーバーの通常アクセスログはクエリ文字列を除外しています。チケット期限後は再発行が必要で、画面の「再接続」で再生位置を引き継いで再取得できます。

Rangeは単一の `bytes=start-end`、`bytes=start-`、`bytes=-suffix` をサポートします。成功時206、無効範囲は416と `Content-Range: bytes */サイズ`。複数範囲はサポートしません。

PDF・動画の配信はファイルストリームを使い、全体をメモリやBlobへ読み込んでから再生する方式ではありません。PDF.jsは256 KiB単位のRange取得と `disableAutoFetch:true,disableStream:true` を使い、不要な先読みを止めています。ただしPDFの構造によっては1ページ表示にも多くの範囲、または全体が必要です。小さなPDFは全体を取得する場合があります。動画はHTML videoのHTTP Rangeによるプログレッシブ再生で、HLS／DASHや帯域に応じた自動画質変更は未実装です。

配信は `Accept-Ranges: bytes`、正確な `Content-Length` と `Content-Range`、`Cache-Control: private, no-store, no-transform` を返します。認証付きのAPIを共有CDNキャッシュに載せたり、途中でgzip等へ変換してRangeのバイト位置を変えないでください。

## 動画カードのプレビュー

本人の続きからの再生・読書は [再開位置仕様](progress.md) を参照してください。分析ログから独立した保存で、プレビューでは更新しません。

POST / GET `/items/:id/preview` の応答は `{state}` です。stateは `absent`（未生成）・`processing`（生成中）・`busy`（待機枠不足）・`ready`（完成）・`unavailable`（生成失敗）です。生成中・混雑時は `retryAfterMs`、完成時は `url,size,maxDuration` を含みます。初回はPOSTし、生成中はGETで確認、busy / absentになった場合は間隔を空けてPOSTします。readyの `url` はBearer認証で取得します。動画用の本編チケットは使いません。

これは元動画のRangeを短く再生する方式ではなく、別の小さい無音クリップです。状態確認・取得ごとに本棚所属を検査し、生成要求も閲覧者が行えます。生成失敗は `unavailable` として返し、元の画像サムネイルを使用します。詳細は [動画プレビュー仕様](video-previews.md) を参照してください。


## 動画変換／HLS（v11）

- 新規動画・音声の `retainOriginal` はセッション作成時のboolean、0.3.1betaから省略時true。明示falseは尊重し、既存セッションの保持指定は変更しません。本の原本は常に残します。
- `GET /uploads`: 本人かつ本棚の編集権限が残る処理中／失敗ジョブの簡易一覧。転送パートのハッシュは含めません。
- `GET /uploads/:id`: `processing:{stage,quality,percent,completed,total}`、`retainOriginal`、失敗動画には `sourceRetained:true`。処理中／失敗動画は24時間の転送期限の後も保持。
- `POST /uploads/:id/retry`: 原本を残した失敗動画の再試行、202。本人の現在のセッション・編集権限を再検査。
- `DELETE /uploads/:id`: 明示取消では原本・分割も削除。完了したアセットは削除しません。
- `GET /items/:id/video`: 生成済み画質・寸法・容量・codec・原本保持状態。旧動画は `legacy:true`。
- `POST /items/:id/playback-ticket`: 新規動画は従来の互換MP4の `url` に加えて `hlsUrl` と画質一覧を返します。
- `GET / HEAD /items/:id/hls/:file`: マスター／各画質マニフェスト、初期化MP4、m4sセグメント。Bearerまたは同アセット限定チケット。生成済みbasenameのみ。各リクエストで現在のセッション・本棚所属を確認します。
- `POST /items/:id/download`: 任意の `{quality:"720p"}`。生成済み画質のみ。省略時は最大画質。既存のボディなし呼出しも維持します。

MIMEは `video/mp4, video/quicktime, video/x-matroska, video/webm, video/x-msvideo, video/x-ms-wmv, video/x-ms-asf, video/mpeg, video/mp2t, video/x-flv` を受信し、内容はFFprobeとデコードで検査します。[動画処理の制限](video-transcoding.md)
