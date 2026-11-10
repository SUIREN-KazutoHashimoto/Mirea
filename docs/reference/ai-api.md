# ローカルAI API（開発ブランチ）

[APIガイド](../api.md) · [登録一覧](api-routes.md) · [実装設計](../design/ai-implementation.md)

基点は /api/v1。すべてBearer認証が必要です。元アセットの現在の本棚権限を適用し、プライベート本棚はX-Mirea-Shelf-Unlockによる追加解除を要求します。管理者権限だけで他人の本棚を参照できるものではありません。時刻と再生位置は整数ミリ秒、ページは1始まり、取得offsetは0始まりです。

## 利用可否・設定・モデル

| 経路 | 契約 |
| --- | --- |
| GET /ai/capabilities | 有効状態、機能、導入済みモデル。手動タグと文字列検索はAI無効でも利用可能 |
| GET/PATCH /admin/ai/settings | 管理者のみ。PATCHはcurrentPassword、設定値。環境変数の上書き、保存値、適用値、範囲を区別 |
| GET /admin/ai/models | 固定モデル候補と導入状態 |
| POST /admin/ai/models/preview | keyを指定し、固定revision・ファイル・容量・SHA-256・利用条件・previewIdを取得 |
| POST /admin/ai/models | currentPassword、previewId、acceptTerms:true、acceptanceHash。確認した同一内容だけ202で受理 |
| POST /admin/ai/models/import | currentPassword、manifest、acceptTerms:true。事前配置ファイルだけを検証し、ネット取得しない |
| POST /admin/ai/models/:id/:action | currentPasswordとresume / pause / remove。参照中の削除を拒否 |
| GET/POST/DELETE /admin/ai/self-test | 合成資料の動作確認。開始・取消は再認証。GETは進行結果 |
| GET /ai/notices | 導入済み推論コードのライセンス文書一覧 |
| GET /ai/notices/:id | 一覧の文書をJSONのtextで取得。任意パスは指定不可 |

modelsは機能名から導入済みモデルIDへの辞書です。設定PATCHに含めたmodelsは辞書全体の置換として扱います。重みやAPI資格情報はクライアントへ返しません。

## 作品・本棚・訂正

機能名は tags / ocr / transcript / structure / chapters / embedding。書籍はocr、音声はstructure、動画はchapters、動画・音声はtranscriptが適用可能です。

| 経路 | 入力・応答 |
| --- | --- |
| GET /items/:id/ai | タグ、公開中の各機能の最初の単位、本人の編集・依頼可否、ジョブ |
| GET /items/:id/ai/:feature | offsetを指定し1単位取得。result、revision、editRevision、inputStamp、nextOffset、hasMore、解析範囲 |
| PUT /items/:id/ai/tags | scope:sharedまたはpersonal、revision、tags、rejected。共有は編集権限、personalは本人。adoptedで自動タグを手動採用 |
| PATCH /items/:id/ai/:feature | requestId、revision（編集版）、resultRevision（公開版）、patch。古い版は409。同一操作番号は冪等 |
| GET /items/:id/ai/:feature?original=true | 現在の単位の原結果も取得。編集権限が必要 |
| GET /items/:id/ai/export | 安定した読取スナップショットから全結果・訂正をJSONとしてストリーム出力 |
| GET /items/:id/ai/related | 現在閲覧できる範囲の共通タグを根拠とする関連作品 |
| GET/PUT /shelves/:id/ai | 自動解析方針。PUTは本棚所有者のみ、enabled・features・revisionが必要 |

patchはblocks / segmentsのID別差分と、splitsの親区間ID別配列です。文字・ラベル・時刻・領域・読む順・hiddenを検査します。対応不能な旧訂正はunresolvedとして保持し、dropUnresolvedによる明示確認だけで現在の差分から外します。過去の編集記録は残します。

## 解析依頼と管理

POST /items/:id/ai/jobsはrequestId、features、regenerateを受け、202でjobIdsを返します。元作品の編集権限またはアップロード所有者としての権限が必要です。AIの失敗は通常メディアの公開状態と独立します。

POST /ai/analyzeはrequestId、featuresとshelfId / seriesId / assetIdsを受け、一括依頼を永続登録します。本棚全体は所有者のみ。明示assetIdsは1000件まで、本棚・再帰シリーズは対象スナップショットから分割登録し1000件で切り捨てません。

GET /ai/jobsとGET /admin/ai/jobsはstate、offset、limit（最大100）、任意のshelfIdを指定します。通常一覧は本人の依頼、管理一覧も元作品の閲覧可能範囲に限定します。プライベート本棚は明示scopeと解除が必要です。

POST /ai/jobs/:id/:actionでpause / resume / retry / cancelを行います。管理画面も同じ経路を使い、依頼者または本棚の編集権限を検査します。再試行は失敗・一部成功・取消の対象だけで、成功した単位を再利用します。GET /ai/batches、POST /ai/batches/:id/:actionは一括登録の状況とpause / resume / cancelです。取消は既に公開した作品や原本を削除しません。

## 検索とタグ整理

POST /ai/searchはquery（500文字まで）、mode:textまたはsemantic、scope、tags（16件まで）、tagMode:allまたはany、offset、limit（最大100）を受けます。scopeはshelfId / seriesId / playlistId / kind。シリーズは子を含みます。通常横断検索はプライベート本棚を含みません。

応答は作品単位のitems、hasMore、offset、semantic、semanticPending、semanticPartialです。hitsはページ・座標、EPUB位置、開始/終了時刻と短い根拠です。短い期限で意味検索の準備ができなければ文字列結果を先に返します。semanticPendingの後続結果をクライアントが無操作で並べ替えないようにします。

GET /ai/tagsは本人または指定本棚のタグ辞書とrevision。POST /ai/tags/bulkはassetIds（最大1000）、scope、action:add/remove、tags。POST /ai/tags/renameはscope、shelfId、from、to、辞書revisionを要求し、範囲と影響を再検査します。

GET/POST /ai/lists、PATCH/DELETE /ai/lists/:idは本人の保存検索条件です。更新にはrevisionを要求します。本人が現在開けない本棚や、明示していないプライベート本棚の条件を通常一覧へ返しません。

## 端末保存

- GET /items/:id/ai/packは最初の単位とタグ、またはfeature・offsetで1単位を返す。
- GET /items/:id/ai/packsはfeature・offsetから最大8単位、約4MiBをまとめる。各パックは個別に検証可能。
- GET /items/:id/ai/timelineは音楽構成・動画章の全区間（最大5000）を返す。
- パックはversion:1、本人・アセットID、serverTime、expiresAt、checksumを持つ。詳細パックはshelfId、入力世代、解析版・編集版を持つ。
- checksumはchecksumフィールドを除いたオブジェクトのJSON表現へのSHA-256。転送は認証付きの既存接続を使う。APK更新情報の署名とは別の仕組み。
- 期限はセッション期限と7日後の早い方。保存時に本人・接続先、取得前の失効世代、チェックサムを検査し、既知の401/403/404/423を通信失敗として扱わない。
- 途中の次単位はnextOffsetを使い、連番と仮定しない。再解析中の異なるrevision・editRevision・inputStampを混ぜない。

## 訂正履歴の確認と復元

GET /items/:id/ai/:feature/editsは編集者向けの履歴一覧です。offsetで50件ずつ取得し、revisionを指定するとその版の差分を返します。revision:0は現在の解析結果に対する訂正なしの状態です。

POSTの同経路はrequestId、revision（現在の編集版）、resultRevision、restoreRevisionを受けます。復元も新しい編集版と履歴として保存し、同じ操作の再送を重複適用しません。現在の入力範囲へ適用できない訂正は検証で拒否し、履歴自体を消しません。元の領域が変わった差分は対応待ちとして保持します。
