# API v1

この文書は[現行作業ツリーの設計](design/overview.md)に対応します。公開済みの特定版を対象にする場合は、そのGitタグのschemaと実装を確認してください。完全なOpenAPI文書はまだありません。本文はクライアント実装に必要な契約を説明し、**全157件のメソッド／パスと登録元は[API登録一覧](reference/api-routes.md)**に掲載します。リンク先のFastify schemaが必須項目・列挙値・個別上限の最終的な定義です。

## 共通契約

基点は`/api/v1`。認証は`Authorization: Bearer <token>`、通常本文は`application/json`、分割PUTは`application/octet-stream`、従来アップロードはmultipartです。IDはUUID、時刻は特記のない限りUnix epochミリ秒、サイズはbyte。ファイル／パート番号は0始まり、書籍のページ番号は1始まりです。

本棚の役割は`owner / editor / viewer`です。本書の「編集」はownerまたはeditor、「本棚所有者」はowner、「管理者」はサーバー管理者を指します。多くのJSON schemaは未知のプロパティを拒否します。

|状態|意味とクライアントの扱い|
|---|---|
|200 / 201|取得／更新成功、または作成成功|
|202|非同期処理を受け付けた。完了ではない。返されたIDで状況確認|
|204|成功、本文なし。JSON parseしない|
|304|ETagで同一内容。保存済み応答を使用|
|400 / 422|形状不正／内容検証失敗。同じ要求を無変更で繰り返さない|
|401|認証失効。保存済みBearerを無制限に再送しない|
|403 / 404|権限不足、または存在／所属を公開しない対象|
|409|revision、名前、内容、枠、保守中などの競合。再取得・選択変更が必要|
|410|期限切れ、または旧クライアント向けに終了した経路|
|413|本文／ファイルの容量上限超過|
|416|Rangeが無効。`Content-Range: bytes */size`を確認|
|423|プライベート本棚の解除が必要。`shelfUnlockRequired`を参照|
|429|回数／並列数の上限。Retry-After等に従う|
|5xx|サーバー／保存先／依存処理の失敗。冪等性を確認して再試行|

エラー本文は`{error, diagnostic?}`です。認証済みの要求には安全な診断が付く場合がありますが、全エラーにトレースがあるとは限りません。HTML等を返すプロキシエラーも扱ってください。[診断の形式](error-diagnostics.md)を参照してください。

APIは原則`no-store`です。許可CORS originは明示設定し、任意のWebページへBearerを公開しません。`Range`、`X-Chunk-SHA256`、`X-Mirea-Shelf-Unlock`、`If-None-Match`等を使用します。認証付き配信を共有CDNキャッシュへ載せたり、gzip変換してRangeの位置を変えたりしないでください。

## 認証・アカウント

登録／変更後のpasswordは12～128文字です。ログインは初期管理者を含む既存の認証情報を扱うため1～128文字を受け付けます。この違いは、一般登録で短いパスワードを許可するものではありません。

|メソッド・パス|入力・応答／認可|
|---|---|
|GET `/config`|認証不要。version、登録可否、上限、転送機能、APK URL等。値をクライアントへ固定しない|
|POST `/auth/register`|`{name,email,password,remember?}` → 201 `{user,token,expiresAt}`。登録許可が必要|
|POST `/auth/login`|`{email,password,remember?}` → `{user,token,expiresAt}`。既定保持期限30日|
|GET `/auth/me`|Bearer → 現在のユーザー|
|POST `/auth/logout`|現セッションを失効し204。関連する再生許可も失効|
|GET/POST/DELETE `/auth/remember`|GETはSecure Cookieから復元、POSTは保持設定、DELETEは保持解除。一般APIのCookie認証ではない|
|GET/PATCH/DELETE `/account`|本人の情報取得／更新／削除。現在のパスワード等の条件は[accounts.js](../server/accounts.js)|

アカウント削除はログアウトではありません。所有権移譲、本人の記録削除、共有データの扱いは[データモデル](design/data-model.md)に従います。

## 本棚・ライブラリ・シリーズ

|メソッド・パス|主な契約|
|---|---|
|GET/POST `/shelves`|所属本棚一覧／`{name,description?}`で作成。作成者はowner|
|PATCH/DELETE `/shelves/:id`|本棚所有者。名称・private設定等の変更／本棚削除|
|GET/POST `/shelves/:id/members`|本棚所有者。メンバー一覧／`{email,role}`で既存アカウントを追加|
|PATCH/DELETE `/shelves/:id/members/:userId`|本棚所有者。editor/viewer変更／共有解除|
|PUT `/shelves/:id/owner`|現在の所有者による移譲。通常のrole変更でownerを複数作らない|
|GET `/shelves/:id/items`|所属必須。`{shelf,series,items}`、本人の進捗・シリーズ情報を含む|
|GET `/library/catalog`|本人の統合カタログ。ETag、304、`?delta=1`対応。[同期設計](design/offline-sync.md)|
|GET `/library/integrity`|本人に関係する名前の不整合等。既存データを勝手に変更しない|
|PATCH `/items/:id`|編集。タイトル等を変更し同階層の名前を再検査|
|DELETE `/items/:id`|編集。原本・派生・関連する仕事を含むアセット削除、204|
|GET/POST `/shelves/:id/series`|一覧は所属、作成は編集。`{title,description?,parentId?,requestId?,reuseExisting?}`|
|GET `/series/:id`|`{series,children,items}`。現在のrevisionと順序|
|PUT `/series/:id`|編集。`{revision,title,description,items:[{assetId,label?}],orderMode?,parentId?,moveAssets?,children?}`|
|GET `/items/:id/series`|所属。シリーズ詳細とcurrentIndex。未所属はseries:null|
|GET `/series/:id/delete-preview`|編集。配下件数と確認用hash|
|DELETE `/series/:id`|編集。`{revision,deleteContents?,onlyIfEmpty?,previewHash?}`。配下削除は明示|
|POST `/series/bulk/preview`|編集。`{ids}` → 対象と確認hash|
|POST `/series/bulk`|編集。`{ids,action:"move"|"delete",previewHash,parentId?,deleteContents?}`|

シリーズ更新のrevision不一致は409です。一括移動・一括削除・配下も含めた削除ではpreviewHashが必須で、一致を検査します。単体の「シリーズだけ削除」はrevisionを検査し、previewHashが渡された場合はその一致も検査します。確認後に対象が変わった場合は409となり、最新のプレビューが必要です。フォルダー取り込みの`reuseExisting:true`は同じ階層の既存シリーズを利用し、既存作品の上書きは許可しません。別階層の同名は許可し、同階層の重複や循環を拒否します。

## プライベート本棚

Bearerに加え解除後の`X-Mirea-Shelf-Unlock`が必要です。解除トークンは最大20件をカンマ区切りで渡せます。内容取得・ダウンロード・編集等も対象です。

|POSTパス|本文|応答／条件|
|---|---|---|
|`/shelves/:id/unlock`|`{password}`|現在のパスワードを検証しtoken・expiresAt|
|`/shelves/:id/biometric/enroll`|`{password,publicKey}`|パスワード確認とP-256公開鍵登録|
|`/shelves/:id/biometric/challenge`|`{keyId}`|登録済み鍵に対する単回challenge、60秒|
|`/shelves/:id/biometric/unlock`|`{challenge,signature}`|登録鍵の署名検証後に解除トークン|

鍵形式、期限、パスワード変更時の失効は[セキュリティ](design/security.md)を参照してください。

## 送信候補と転送状況

|メソッド・パス|契約|
|---|---|
|POST `/transfers/upload-preview`|候補の型・保存先・衝突を事前検査。ファイル本体の送信・公開はしない|
|POST `/transfers/upload-queue`|`{assets:[{id,shelfId,seriesId?,title,mimeType,totalBytes}]}`を登録。[transfer-queue.js](../server/transfer-queue.js)|
|GET `/transfers/upload-queue/:id`|本人の候補とリンク済みuploadId|
|DELETE `/transfers/upload-queue/:id`|未開始の候補だけを削除。開始済みは409|
|POST `/transfers/upload-queue/cancel`|候補ID配列を取消。開始済みupload IDは別途取消を判断|
|GET `/transfers/uploads`|本人のアセット単位の状況・保存先・時間情報。現在の行と履歴cursor|
|POST `/transfers/uploads/clear-attention`|失敗／中止行を本人の表示から除外。本体削除ではない|
|GET `/transfers/manual-upload`|本人の追加枠の状態、空きはslot:null|
|POST `/transfers/upload-queue/:id/start`|本人の未開始候補を追加1枠で要求、202。別の追加枠を使用中なら409|

候補は1回最大1,000件、ユーザーごとの未開始候補は10,000件、通常24時間で失効します。別端末にファイル本体は転送しません。履歴cursorは応答値を不透明な文字列として再利用してください。

## 分割アップロード

1. 編集権限でPOST `/shelves/:id/uploads`へ次のJSONを送ります。PDF・EPUB・音声・動画は1ファイル、画像書籍はページ順の静止画像を複数指定します。

```json
{
  "title": "サンプル作品",
  "retainOriginal": true,
  "seriesId": null,
  "files": [{"filename": "sample.mp4", "mime": "video/mp4", "size": 8388608}]
}
```

2. 201応答のid、chunkSize、expiresAt、filesの受信状況を保存します。`resume:true`は一致する未完セッションを探します。`clientTransferId`は送信候補へ結び付けるUUIDです。
3. PUT `/uploads/:id/files/:fileIndex/parts/:partIndex`へbytesを送ります。`X-Chunk-SHA256`は64桁の小文字hex。同一内容の再送は204、既存内容との矛盾は409、受信長／hash不一致は422です。
4. POST `/uploads/:id/complete`は202で処理を受け付け、完了済みは200。未受信があれば409です。**202後は次の通常送信を開始でき、変換完了を待ちません。**
5. GET `/uploads/:id`は詳細、GET `/uploads/:id/status`は軽量状態、POST `/uploads/status`はまとめた軽量照会。GET `/uploads`は互換の簡易一覧です。
6. POST `/uploads/:id/retry`は保持した失敗入力を再検査して202で再試行。DELETE `/uploads/:id`は未公開の送信を中止して204。公開済みなら409となり、アセット削除を明示する必要があります。

総サイズは`/config`に従います。1回のUI選択は最大1,000ファイル、画像書籍は最大1,000ページ、1画像100 MiB、EPUB原本64 MiBです。通常送信枠は設定値で、固定3件と仮定しません。`processing`は通常送信枠に含めません。[状態遷移・復旧・取消](design/upload-jobs.md)も参照してください。

従来POST `/shelves/:id/items`はmultipartの`title`と`file`を受け取り、生成まで待つ互換経路です。新しいクライアントは分割プロトコルを使用してください。

## メディア取得・Range・チケット

|メソッド・パス|応答と認可|
|---|---|
|GET/HEAD `/items/:id/thumbnail`|所属。長辺最大1024pxのWebP。元画像／overrideは別途保持|
|GET `/items/:id/pages`|画像書籍のページ一覧。原本URLと利用可能なら表示用URL|
|GET/HEAD `/items/:id/pages/:number/content`|所属。1始まりのページ原画像|
|GET/HEAD `/items/:id/pages/:number/display`|所属。表示用派生画像|
|GET/HEAD `/items/:id/epub`|所属。サニタイズした読書用bundle|
|POST `/items/:id/playback-ticket`|所属と追加解除を検査。`{url,expiresAt,size,mimeType,original,hlsUrl?,renditions?}`|
|GET/HEAD `/items/:id/content`|Bearerまたは有効なチケット。単一Range|
|GET `/items/:id/video`|配信世代、画質候補、原本保持等。旧形式はlegacy|
|GET/HEAD `/items/:id/renditions/:quality/content`|画質別MP4。同じ認可とRange|
|GET/HEAD `/items/:id/hls/:file`|生成済みmanifest／init／segment。Bearerまたはチケット|
|GET/POST `/items/:id/preview`|状態／生成要求。ready時URL等、待機時retryAfterMs|
|GET/HEAD `/items/:id/preview/content`|Bearerと所属。無音の短いMP4、Range。本編チケットとは別|
|GET `/items/:id/navigation`|チャプター、字幕、生成状態|
|GET `/items/:id/navigation/storyboard`|シーク用画像|
|POST `/items/:id/navigation/prepare`|ナビゲーション準備要求|
|PUT `/items/:id/navigation`|編集とrevisionを確認してチャプター／字幕更新|

`bytes=start-end`、`bytes=start-`、`bytes=-suffix`の単一Rangeをサポートし、複数Rangeは拒否します。成功は206、範囲なしは200、HEADはヘッダーのみです。配信はAccept-Ranges、正確なContent-Length／Content-Rangeを使います。HLSのmanifestはテキスト、segmentは別のバイナリ応答です。

チケットはアセットと配信世代に結び付き、現セッションを超えて有効になりません。URLを公開ログへ出さないでください。HLSのABRは実装済みです。「HLS未対応」という旧仕様は現行に適用しません。

## プレイリスト・進捗・履歴・表紙

|メソッド・パス|契約|
|---|---|
|GET/POST `/playlists`|本人の一覧／`{title,requestId?}`で作成。最大200|
|PUT `/playlists/:id`|`{revision,title,assetIds}`。最大1,000、一意、同じ種類。混在422、競合409|
|DELETE `/playlists/:id`|revision付き削除。元アセットは削除しない|
|GET `/playlists/:id/playback?assetId=…`|音声か動画の同種類の順序・currentIndex|
|GET `/items/:id/progress`|本人の`{progress,revision}`。未記録はnull／0|
|PUT `/items/:id/progress`|revision・updateId必須。時間メディアはpositionMs・durationMs、書籍はpage等。本文2 KiB|
|GET `/history`|本人の履歴順。現在閲覧可能なアセットのみ。private本棚は除外|
|DELETE `/history`、`/history/:id`|本人の表示履歴を隠す。生統計／進捗を消さず、再閲覧で掲載可能|
|POST `/thumbnails/custom`|編集。assetIdsかseriesIdの一方と`image:{mime,base64}`。JPEG/PNG/WebP、復号後5 MiBまで|
|DELETE `/thumbnails/custom`|同じ対象指定でoverride解除。自動表紙へ戻す|
|GET/POST `/items/:id/thumbnail-job`|所有者等の利用可否・状態／`{acknowledgeCost:true}`で再生成、202|

進捗では同じupdateId・同じ内容を冪等に処理し、別内容のID再利用やrevision不一致を409にします。古い編集内容を最新revisionへ機械的に付け替えて再送しないでください。

## ダウンロード・統計・診断

|メソッド・パス|契約|
|---|---|
|POST `/items/:id/download`|本人のmanifest登録／再利用。動画は任意の`{quality}`。鍵は返さない|
|GET `/downloads/:id/files/:file/parts/:part`|本人と現在の所属。認証付き暗号チャンク|
|POST `/downloads/:id/open`|本人・現在の所属・内容整合性。key、serverTime、expiresAt、manifest、userId|
|POST `/analytics/events`|schemaVersion 1の本人イベント。50件／64 KiB。同一ID／内容は再送成功、別内容409|
|GET `/analytics/me/summary`、`/me/events`|本人の詳細。期間等とevent cursor、JSON／NDJSON|
|GET `/analytics/access`|全体匿名集計の閲覧可否|
|GET `/shelves/:id/analytics/summary`、`/export`|本棚所有者の匿名集計|
|GET `/analytics/global/summary`、`/export`|管理者の全体匿名集計|
|GET `/items/:id/replay-heatmap`|固定条件の再生頻度。任意queryは拒否|
|POST `/diagnostics/batches`|本人の明示送信。`{id,reports}`、20件／128 KiB、毎分3回|
|GET `/admin/diagnostics`|管理者。送信単位の安全な診断。beforeで過去ページ、100件まで|

暗号形式と7日の許可は[オフライン設計](design/offline-sync.md)、統計は[統計設計](analytics.md)を参照してください。診断に生の例外文字列を追加しません。

## サーバー管理

以下は有効な管理者専用です。重い操作は`acknowledgeCost:true`等の確認値を要求します。破壊的な処理はプレビューと確認を省略できる汎用管理口ではありません。

|領域|パスと操作|契約・確認点|
|---|---|---|
|権限・状態|GET `/admin/access`、`/overview`、`/storage-usage`|管理者可否、処理／容量。基本メディアと派生込みを区別|
|アカウント|GET/POST `/admin/users`、PATCH/DELETE `/admin/users/:id`|作成・役割・有効化等。管理者保護と所有権条件|
|本棚|GET `/admin/shelves`、GET `/admin/shelves/:id/members`、PUT `/admin/shelves/:id/members/:userId`|管理用の権限操作|
|監査|GET `/admin/audit`|管理操作。一般アセット履歴の公開口ではない|
|処理設定|GET/PATCH `/admin/processing-settings`|送信／各レーン上限。環境変数上書きを識別|
|運用設定|GET/PATCH `/admin/server-settings`|管理画面で変更できる設定。秘密／起動パス設定とは別|
|名前不整合|GET `/admin/series-name-conflicts`|既存衝突を表示。自動修正しない|
|ジョブ一覧|GET `/admin/jobs/list`|view=current/history、state、q、sort、offset、limit（最大200）。rows,total,nextOffset,summary等|
|互換ジョブ一覧|GET `/admin/jobs`|新規クライアントはページング一覧を使う|
|追加ジョブ枠|POST `/admin/jobs/:id/start`|`{source:"admin"|"media"|"upload",acknowledgeCost:true}` →202。管理者ごと1枠|
|アセット検索|GET `/admin/assets`|qとafter、100件＋nextCursor|
|再生成|POST `/admin/assets/:id/regenerate`、`/admin/assets/regenerate-all`|`{kind:"thumbnail"|"preview"|"transcode",acknowledgeCost:true}` →202|
|未完了修復|GET `/admin/assets/repair-preview`、POST `/admin/assets/repair-incomplete`|未完了／壊れた派生だけを確認・再実行。実行中は除外|
|送信再試行|POST `/admin/uploads/:id/retry`|保持した入力と現権限を確認|
|旧再試行口|POST `/admin/jobs/retry`|旧クライアント向け移行エラー。新規実装では使わない|
|バックアップ|GET/POST `/admin/backups`、DELETE `/admin/backups/:id`、GET/HEAD `/admin/backups/:id/content`|メタデータのみ／全体を区別。鍵を含む保管物のアクセスに注意|
|不要ファイル|POST `/admin/cleanup/scan`、`/delete`|候補を確定し確認した対象を削除。任意パス削除ではない|
|リセット|GET `/admin/reset`、POST `/admin/reset/preview`、`/apply`、`/recover`|保守状態、確認、バックアップ／復旧を伴う|
|サーバー更新|GET `/admin/updates/status`、POST `/check`、`/apply`|実行形態と許可された更新方式を確認|

正確な確認文・入力項目は[登録元](reference/api-routes.md)のschemaを参照してください。設定キーと再起動要否は[設定リファレンス](reference/configuration.md)にまとめています。

## APK配布・ヘルスチェック

GET/HEAD `/app-updates/android/manifest`は署名済み更新案内、`/apk/:code`と`/latest.apk`はAPKです。配布が未設定、署名／期限が不正、版が存在しない場合は取得できません。クライアントはAPK本体のhash・サイズ・署名者も検証します。

ヘルスチェックだけは基点外のGET `/api/health`です。生存確認を利用者のライブラリや履歴を読む試験で代用しないでください。

## 文書の更新

ルート追加後は`node scripts/generate-api-inventory.mjs`で一覧を再生成し、認可・本文・応答・失敗の意味を追記します。`--check`で生成差分を確認できます。静的抽出の対象外へ登録方式を変えた場合は生成器も更新してください。
