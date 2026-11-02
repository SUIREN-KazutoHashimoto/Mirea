# 開発環境を作る

この手順はソースを改修する人向けです。作品やアカウントを入れた稼働中の保存先は使いません。完成すると、同じPCでAPIと開発画面を起動し、合成素材で変更を確認できます。

## 1 必要なツール

| 用途 | このコードが指定するもの | 確認 |
| --- | --- | --- |
| ソース | Git | `git --version` |
| JavaScript | Node.js 24.13.0以上の24.x | `node --version` |
| 依存管理 | pnpm 11.25.0 | `pnpm --version` |
| Linuxのメディア処理 | OSのFFmpegとFFprobe | `ffmpeg -version` / `ffprobe -version` |
| Android開発時のみ | JDK 21、SDK Platform 36、Build Tools 36.0.0 | Android StudioのSDK Manager |
| コンテナ検証時のみ | DockerとCompose v2、対応Linuxカーネル | [コンテナの条件](../container-security.md) |

Windows/macOSのFFmpeg・FFprobeは依存インストール時の同梱版を使います。Linuxは既定で `/usr/bin/ffmpeg` と `/usr/bin/ffprobe` を使います。Debian/Ubuntuの例は `sudo apt-get install ffmpeg` です。別の場所なら[設定](../reference/configuration.md)で明示します。

pnpmがない場合は、Node.jsの導入後に次を実行します。

```sh
npm install --global pnpm@11.25.0
```

ツールは利用者が管理できる配置先を使います。依存インストールを通すためにMireaのサービスを管理者で起動しないでください。

## 2 ソースを取得する

新しい作業用フォルダで実行します。既存の変更があるフォルダへ上書きしません。

```sh
git clone --branch develop https://github.com/SUIREN-KazutoHashimoto/Mirea.git mirea-dev
cd mirea-dev
git switch -c work/my-change
pnpm install --frozen-lockfile
```

成功すると `node_modules` が作られます。ロック不一致で止まる場合は、Node/pnpmの版、ブランチ、ロックの差分を確認します。依存変更が必要でないのに `--no-frozen-lockfile` で進めないでください。フォークの場合は[フォーク手順](fork.md)のclone元を使います。

## 3 開発専用データを指定する

作業フォルダ直下に新規の `.env` を作ります。既存ファイルは上書きせず、内容を確認して追記します。

```dotenv
HOST=127.0.0.1
PORT=3000
DATA_DIR=./.local/dev-data
APP_UPDATES_SOURCE=disabled
```

`.local/dev-data` は開発専用です。`MEDIA_DIR` は最初は設定しません。通常設定は管理画面を使い、固定したい項目だけ環境変数へ書きます。`.env` と `.local` はGit管理外です。

`APP_UPDATES_SOURCE=disabled` は公式APKの更新JSONを自動取得しない設定です。更新機能を検証するときだけ、公開鍵と一致する独立した検証用配信を準備します。

## 4 APIと画面を起動する

作業フォルダでビルドし、APIを起動します。

```sh
pnpm build
pnpm start
```

ブラウザーで `http://localhost:3000/api/health` を開きます。`status: "ok"` と版が返ればAPIの起動は成功です。`http://localhost:3000` で本番ビルドの画面を確認できます。

Webを編集する場合はAPIを起動したまま、**別のターミナルで同じ作業フォルダへ移動して**実行します。

```sh
pnpm dev
```

表示されたViteのURLを開きます。通常は `http://localhost:5173` です。`/api` は `127.0.0.1:3000` へ転送されます。APIのポートを変える場合は [vite.config.js](../../vite.config.js) のproxyも合わせます。`pnpm dev` 単体ではAPIは起動しません。

ユーザーが0件のDBには初期管理者 `admin@example.com` / `ChangeMe` が作られます。この情報でログインし、「設定 → アカウント」でメールアドレスとパスワードの両方を変更してください。その後は[初回操作](../user/first-steps.md)に沿って架空の本棚と作品だけを登録します。実サービスのパスワードは使い回しません。

## 5 変更を確認する

1. Web変更はVite側で確認します。API変更はAPIを停止して起動し直します。
2. 対象の単体/APIテストを実行します。[テストガイド](testing.md)に例があります。
3. `pnpm build` を通し、本番ビルドにも変更が含まれることを確認します。
4. 操作、API、保存形式の変更を対応する文書へ反映します。

停止は各ターミナルで `Ctrl+C` です。開発データを残せば次回も続きから確認できます。削除時は開発専用の絶対パスを確認してから手動で行ってください。

## Androidを開発する

1. Android StudioでSDK Platform 36、Build Tools 36.0.0、エミュレーターを導入します。JDKは21です。
2. `ANDROID_HOME` またはStudioが作る `android/local.properties` でSDKの場所を指定します。
3. リポジトリ直下で実行します。

```sh
pnpm android:sync
pnpm android:open
```

`android:sync` はWebビルドとCapacitor同期を行います。Web変更後は再度同期します。生成された `android/app/src/main/assets/public` を直接修正しません。

CLIで検証する場合は `android` へ移動します。

**Windows PowerShell**

```powershell
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

**Linux/macOS**

```sh
./gradlew testDebugUnitTest lintDebug assembleDebug
```

出力は `android/app/build/outputs/apk/debug/app-debug.apk` です。配布用署名とは異なるため、普段使っているアプリをアンインストールして置き換える確認はしません。エミュレーターか専用端末で使います。

アプリからは信頼済みHTTPSが必要です。エミュレーター内の `localhost` は開発PCとは別であり、HTTP許可や証明書検証回避では解決しません。[HTTPS手順](../install/https.md)で到達可能なURLを準備します。

## 変更対象を探す

| 対象 | 主な入口 |
| --- | --- |
| ライブラリ | `web/src/main.js`、`library-collection.js`、`collection-view.js` |
| 転送UI | `web/src/upload-ui.js`、`upload-review.js`、`upload-batch.js` |
| 受付・後処理 | `server/resumable.js`、`transfer-queue.js`、`media-pipeline.js` |
| API・認証 | `server/app.js`、`security.js` |
| DB | `server/database.js` |
| Web再生 | `web/src/video-player.js`、`video-stream.js`、`book-viewer.js` |
| Android | `android/app/src/main/java/com/suiren/mirea/playback`、`transfer` |
| 設定 | `server/operational-settings.js`、`processing-settings.js` |
| 配布 | `.github/workflows/verify.yml`、`scripts/package-server.mjs` |

責務を変える前に[全体設計](../design/overview.md)を読み、同じ状態をWebとnativeが別々に持っていないか確認します。
