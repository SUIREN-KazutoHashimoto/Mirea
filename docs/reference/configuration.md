# サーバー設定リファレンス

対象は[現在のチェックアウト](../status.md)です。操作手順は[管理画面の設定](../operations/settings.md)、起動方式は[導入方法](../install/choose.md)を参照してください。秘密値や環境固有の設定をGitへ保存しません。

## 優先順位

通常の運用設定は **環境変数 → 管理画面でDBに保存した値 → 組み込みの初期値** の順に適用します。環境変数が設定されている項目は管理画面から上書きできません。環境変数を外して再起動すると、DBに保存してあった値が適用されます。

直接起動ではインストール先の `.env` を読みます。起動したプロセスに既にある環境変数が `.env` より優先します。Composeの `.env` はYAMLへの値の展開であり、全項目が自動的にコンテナへ渡る仕組みではありません。YAMLの `environment` に指定された値がコンテナの環境になります。

現行の `.env.example` とCompose例には、初期値を明示する行が含まれます。その行も「明示した上書き」です。管理画面で変更したい場合は、その項目の `.env` とComposeの `environment` 両方を確認し、上書きを外して再起動します。値を空文字にすることとは異なります。

例外として `SERVER_ADMIN_USER_IDS` による管理者指定は、DBに保存した明示的な権限変更が優先します。

## 起動と保存先

これらは管理画面では変更せず、サービスの起動設定で指定します。

| 変数 | 直接起動の初期値 | 意味と注意 |
| --- | --- | --- |
| HOST | `127.0.0.1` | 待受アドレス。Compose内は `0.0.0.0`、ComposeのHOST変数はホスト側公開アドレス |
| PORT | `3000` | 待受ポート。通常1〜65535。0は直接起動での動的割当用で、通常運用/healthcheckには使わない |
| DATA_DIR | `./data` | DB、鍵、表紙、管理データ。相対パスはインストール先基準 |
| MEDIA_DIR | 未設定 | 原本・配信用メディアを分離。設定前に移行が必要。空文字不可 |
| HTTPS_KEY_FILE | 未設定 | 直接HTTPSの秘密鍵PEM。CERTと同時に指定 |
| HTTPS_CERT_FILE | 未設定 | 直接HTTPSのサーバー証明書チェーンPEM |
| CORS_ORIGINS | `https://localhost` | カンマ区切りの許可Origin。Android同梱画面用の既定値を含む |
| FFMPEG_PATH | Linux: `/usr/bin/ffmpeg`、他: 同梱版 | 実行バイナリの明示指定 |
| FFPROBE_PATH | Linux: `/usr/bin/ffprobe`、他: 同梱版 | FFmpegと整合する解析バイナリを指定 |

TLSの片方だけ指定、不正な鍵、読めない証明書は起動エラーになり、HTTPへ自動的に戻しません。保存先変更は単なる設定変更ではありません。[保存先移行](../storage.md)に従います。

## 管理画面から保存し再起動する設定

場所はサーバー管理の設定画面です。保存値と適用中の値を区別し、再起動が必要な表示を確認します。

| 画面/APIキー | 環境変数 | 初期値 | 設定範囲 |
| --- | --- | --- | --- |
| maxUploadBytes | MAX_UPLOAD_BYTES | 2,147,483,648 bytes（2 GiB） | 1 MiB〜1 TiB |
| uploadChunkBytes | UPLOAD_CHUNK_BYTES | 8,388,608 bytes（8 MiB） | 64 KiB〜16 MiB |
| allowRegistration | ALLOW_REGISTRATION | true | true / false |
| analyticsEnabled | ANALYTICS_ENABLED | true | true / false |

上限値は設定を受け付ける範囲であり、任意の端末や保存先でその容量を処理できる保証ではありません。総量の上限と、1リクエストの分割サイズは別です。10 GiBにする場合、maxUploadBytesは `10737418240` です。プロキシは分割要求を受けられる必要があります。

登録を停止しても既存ユーザーのログインは止まりません。閲覧記録の収集停止は新規収集を止める設定で、既存記録の削除ではありません。

## 即時反映する処理数

管理画面で保存するとキューの割当へ反映します。すでに実行中の処理を、新しい上限に合わせるためだけに中断しません。環境変数の変更・解除はプロセス再起動が必要です。

| キー | 環境変数 | 初期値 | 範囲 |
| --- | --- | --- | --- |
| maxConcurrentUploads | MAX_CONCURRENT_UPLOADS | 3 | 1〜32 |
| maxConcurrentJobs | MAX_CONCURRENT_JOBS | 5 | 1〜16 |
| maxConcurrentThumbnails | MAX_CONCURRENT_THUMBNAILS | 2 | 1〜8 |
| maxConcurrentPreviews | MAX_CONCURRENT_PREVIEWS | 1 | 1〜8 |
| maxConcurrentIngest | MAX_CONCURRENT_INGEST | 2 | 1〜8 |
| maxUploadAssets | MAX_UPLOAD_ASSETS | 1000 | 1〜1000 |

送信枠と後処理枠は別です。maxConcurrentJobsだけですべての種類のジョブを一括制限するわけではありません。手動開始の追加枠と依存関係は[ジョブ設計](../design/upload-jobs.md)にあります。

MAX_UPLOAD_ASSETSに1000を超える値が残る既存設定は1000へ丸められます。他の不正値を都合よく無視して起動する設計ではありません。並列数はCPU数だけでなく、画像展開、変換メモリー、一時領域、ストレージ負荷を見て調整します。

## 管理者と更新

| 変数 | 初期状態 | 意味 |
| --- | --- | --- |
| SERVER_ADMIN_USER_IDS | 空 | 既存アカウントUUIDをカンマ区切りで指定。メールではない。DBの明示権限が優先 |
| APP_UPDATES_DIR | 未指定 | 検証済み公開バンドル `manifest.json` とAPKを置く場所。秘密鍵を入れない |
| APP_UPDATES_SOURCE | disabled以外では取得有効 | `disabled` で公式ReleaseからのAPK更新JSON取得を停止 |
| WINDOWS_MAINTENANCE_DIR | 未指定 | レビュー済み専用保守ヘルパーとの連携先。一般導入では設定しない |
| VITE_API_URL | 未指定 | Web資産ビルド時のAndroid初期接続先。サーバー再起動だけではAPKへ反映されない |

空DBの通常起動では初期管理者が別途作られます。SERVER_ADMIN_USER_IDSを設定することが初回利用の必須手順ではありません。

APP_UPDATES_DIR未指定でも、通常起動はサーバーと同じ版の公式署名付き更新JSONを取得します。未配置・ネットワーク障害・期限切れなどは[Android更新](../android-updates.md)を参照します。サーバーの最新版探索と、同版のAPK更新情報取得は別機能です。

## コンテナとHTTPSのhealthcheck

| 変数 | 用途 |
| --- | --- |
| NODE_ENV | 配布コンテナはproduction |
| XDG_CACHE_HOME | 配布コンテナは `/tmp/mirea-cache`。メディア処理の一時キャッシュ |
| HEALTHCHECK_CA_FILE | 直接HTTPSのhealthcheckで使うCA公開証明書 |
| HEALTHCHECK_TLS_SERVER_NAME | ローカル接続でも照合する証明書名。未指定時localhost |
| MIREA_TRUENAS_PREFLIGHT | `1` の場合に既存の専用HTTPS起動検査を有効化 |
| MIREA_INSTALL_ID / MIREA_STORAGE_GROUP_ID | 専用検査の導入識別子と保存先グループ |
| MIREA_TLS_IP | 専用検査で証明書SANと照合するIP |
| MIREA_TLS_ROOT_SHA256 / MIREA_TLS_LEAF_SHA256 / MIREA_TLS_SPKI_SHA256 | 専用検査で固定するCA・leaf・公開鍵のSHA-256 |

これらの専用検査はすべてのTrueNAS導入で必須ではありません。TLSをプロキシで終端する汎用導入と、既存の厳密な直接HTTPS構成を混同しないでください。固定パス・所有権・領収情報の条件は[コンテナ保護](../container-security.md)を参照します。

healthcheckはコンテナ内の `127.0.0.1` へ接続し、TLSを使う場合も検証を省きません。設定を変えた後はhealthcheckと端末からのHTTPS接続の両方を確認します。

## 定義と検証

正本は [runtime.js](../../server/runtime.js)、[operational-settings.js](../../server/operational-settings.js)、[processing-settings.js](../../server/processing-settings.js)、[admin-access.js](../../server/admin-access.js)、[healthcheck.mjs](../../server/healthcheck.mjs) です。[設定回帰テスト](../../tests/server-settings-0230.test.js)は保存値・環境変数・適用値の区別を検証します。

テスト専用フラグやNodeの内部フラグは通常運用の設定APIではありません。起動エラーを回避するために内部パラメーターを推測して追加しません。
