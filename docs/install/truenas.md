# TrueNAS Custom Appへ導入する

TrueNASはMireaを動かすコンテナ基盤の一つです。この手順は汎用的な新規導入例で、特定の利用者の構成を表すものではありません。既存アプリの再作成・データ移行は[バックアップと復元](../operations/backup-restore.md)を先に確認します。

対象: Mirea `1.0.0`。画面名はTrueNAS 25.04系のCustom Appを基準にします。配布イメージの例は固定タグ`1.0.0`です。GitHub Releasesで公開状態を確認してください。別のTrueNAS版では項目名と対応機能を公式資料で確認します。

## 1. 始める前の準備

必要なもの:

- DockerベースのAppsが設定済みのTrueNASとx86-64 CPU。
- Landlock ABI 3以上が有効なホスト。イメージの起動検査に通ること。
- Mirea用の実行ユーザー／グループ。以下はUID/GID `1000:1000` の例です。既存の別用途ユーザーと衝突する場合は、専用の非root IDを決めます。
- Mirea専用の2つの空データセットと、その読み書き権限。
- 利用端末が信頼するHTTPSリバースプロキシ。構成は[HTTPS](https.md)を参照します。

Appsのプールを選んだことと、Mirea用のHost Pathを用意したことは別です。Host Pathはインストール前に作成します。

## 2. 保存先を用意する

例の `POOL` は自分のプール名に置き換えます。同じプールの別データセットでも利用できます。

| ホスト側の例 | コンテナ内 | 主な内容 |
| --- | --- | --- |
| `/mnt/POOL/apps/mirea/data` | `/data` | DB、ユーザー・本棚情報、鍵、表紙、プレビュー |
| `/mnt/POOL/apps/mirea/media` | `/media` | 原本、再生用ファイル、HLS、書籍、転送途中データ |

1. Datasets画面でMirea専用のデータセットを作ります。
2. 実行するUID/GIDが所有し、必要な読み書きとディレクトリ通過ができるよう権限を設定します。親フォルダーにも通過権限が必要です。
3. この領域を一般利用者向けSMB共有にしません。既存共有全体のACLを置き換えません。
4. `/data` と `/media` が別の実パスで、入れ子やシンボリックリンクではないことを確認します。

DBとユーザー情報・アセットメタデータは一つのSQLiteに入ります。data/media分離はDBを二つに分ける機能ではありません。[保存先の詳細](../storage.md)

## 3. GUIから追加する

AppsのDiscover AppsからCustom Appのインストール画面を開きます。25.04の項目は[公式Custom App画面説明](https://www.truenas.com/docs/scale/25.04/scaleuireference/apps/installcustomappscreens/)で確認できます。

次を入力します。空欄と書いた項目は独自の値で上書きしません。

| 分類 | 項目 | 入力する値 |
| --- | --- | --- |
| アプリ | Application Name | `mirea` |
| イメージ | Repository | `ghcr.io/suiren-kazutohashimoto/mirea` |
| イメージ | Tag | 選んだ固定版。例 `1.0.0` |
| イメージ | Pull Policy | 固定版は未取得時取得。追従タグなら更新時に再取得する設定 |
| コンテナ | Entrypoint / Command | 空欄。イメージ既定値を使う |
| セキュリティ | Custom User | 有効。保存先に合わせたUID/GID |
| セキュリティ | Privileged | 無効 |
| セキュリティ | 追加Capabilities | なし |
| ネットワーク | Host Network | 無効 |
| ネットワーク | Container Port | TCP `3000` |
| ネットワーク | Host Port | 例 `13000`。使われていない番号 |
| ネットワーク | Host IP | プロキシが接続する特定アドレス。全面公開を初期値にしない |
| ストレージ | Host Path | 上の2パスを `/data`・`/media` へ読み書きマウント |
| ヘルスチェック | Disable Builtin Healthcheck | 無効 |
| 資源 | CPU / Memory | 例2 CPU / 4096 MiB。高負荷用途は測定して調整 |

環境変数は次を設定します。

```dotenv
HOST=0.0.0.0
PORT=3000
DATA_DIR=/data
MEDIA_DIR=/media
NODE_ENV=production
XDG_CACHE_HOME=/tmp/mirea-cache
CORS_ORIGINS=https://localhost
```

内部の `HOST=0.0.0.0` はコンテナ内の待受です。ホスト側の公開アドレスはNetwork Configurationで制限します。アップロード容量・登録可否・処理数などは省略すると管理画面から変更できます。GUIへ明示した環境変数は管理画面より優先されます。[設定](../operations/settings.md)

プロキシも別コンテナの場合、`127.0.0.1`はそのプロキシ自身を指します。同じ私設ネットワークのサービス名か、NASの限定LANアドレスを使います。Host Portへ直接クライアントを接続する構成にせず、HTTPS入口を使います。

25.04系GUIでDockerの `read_only`・`cap_drop`・`no-new-privileges` を指定できない場合でも、Mireaのランチャーが非root・no_new_privs・Landlockを検査／適用します。これはDocker側の同じ設定を代わりに書き換えるものではありません。検査に失敗したら起動条件を確認します。[起動保護](../container-security.md)

## 4. YAMLから追加する場合

GUIの代わりにInstall via YAMLを選ぶ場合は、リリースに付属する `mirea-truenas-25.04.yaml` または[リポジトリの例](../../deploy/truenas/compose.yaml)を使います。

1. アプリ名を決めます。
2. 2つの `source` を自分の実在するデータセットへ置き換えます。
3. UID/GID、ポート、プロキシへの接続先を決めます。
4. 管理画面で設定したい `MAX_UPLOAD_BYTES`・`UPLOAD_CHUNK_BYTES`・`ALLOW_REGISTRATION`・`ANALYTICS_ENABLED` の行は、YAMLの `environment` から省きます。
5. `create_host_path:false` と起動保護、永続マウントを維持して登録します。

この例の `/tmp` は256 MiBです。大量の高解像度画像・複数ジョブで不足する場合は、ジョブ数を下げるか、利用可能メモリーを確認して一時領域を調整します。tmpfsの上限を大きくするだけで物理メモリーが増えるわけではありません。

## 5. 初回起動を確認する

1. Apps画面でアプリが稼働し、コンテナのヘルスチェックが成功するまで待ちます。
2. ログに `Mirea container sandbox enforced` があることを確認します。
3. 信頼されたHTTPS URLでMireaのログイン画面を開きます。
4. 空の新規環境なら `admin@example.com` / `ChangeMe` でログインし、メールアドレスとパスワードを両方変更します。
5. 小さな検証用作品を追加して、表紙・再生・ダウンロードを確認します。
6. アプリを停止・再開し、同じ作品とアカウントが残ることを確かめます。

Custom AppのApplication Infoに表示される版やアイコンは、Mirea本体と一致しない場合があります。本体の版はMireaの設定または `/api/health` で確認します。

## 6. 更新・バックアップ

- [更新手順](../operations/updates.md)に従い、停止中のdata/mediaと設定・証明書を同じ時点で保管します。Host Pathが自動バックアップされるとは扱いません。
- 固定タグは自動で次の版になりません。版を選んで変更します。`beta` / `stable` の意味は[チャネル説明](../container-channels.md)を確認します。
- 「Up to date」表示だけで本体版を判断せず、イメージ取得設定と実行中の版を確認します。
- App削除時にデータセットを削除しません。起動エラーを直すために識別ファイルやDBを消しません。

導入後の問題は[トラブルシューティング](../operations/troubleshooting.md)へ進みます。NASの管理API、Dockerソケット、管理者資格情報をMireaへ渡す必要はありません。
