# 直接起動とコンテナ起動

MireaはOS上のNode.jsでも、Dockerコンテナでも同じサーバーを実行します。機能差はありません。PCブラウザとAndroidはどちらにも同じHTTPS APIで接続できます。Cloudflare Tunnelの接続先も、ホスト上の `http://127.0.0.1:3000` を使う構成なら、方式を変えてもそのままです。ポートを変更した場合は接続先も合わせてください。

## 1. Node.jsで直接起動する

Dockerのインストール・起動は不要です。Node.js 24.13以上の24.xとpnpm 11.25.0を用意し、リポジトリのルートで実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`http://localhost:3000` を開きます。停止は `Ctrl+C` です。再開は `pnpm start` だけで行えます。ソースを更新した場合は、停止・データのバックアップ後に依存関係の更新とWebビルドを再実行してください。

初回に `.env.example` を `.env` として保存し、必要な設定を変更します。既存の `.env` は上書きしないでください。最小設定例:

```dotenv
HOST=127.0.0.1
PORT=3000
DATA_DIR=./data
UPLOAD_CHUNK_BYTES=8388608
```

`.env` は `server/index.js` があるインストール先のルートから読みます。`DATA_DIR` の相対パスもそのルートから解決します。別フォルダを作業ディレクトリにして `node /path/to/Mirea/server/index.js` を起動しても、意図せず別のDBを作りません。明示的なOS環境変数は `.env` より優先します。サービスマネージャーから起動する場合も同じエントリポイントを使います。

本番の保存先には絶対パスを推奨します。Windowsなら `DATA_DIR=C:/MireaData`、Linuxなら `DATA_DIR=/var/lib/mirea` のように指定し、実行ユーザーが読み書きできるディレクトリを用意してください。Node.jsを管理者／rootで起動する必要はありません。

FFmpegは通常 `ffmpeg-static` が取得したバイナリを使います。取得できないプラットフォームや制限された環境では、別途FFmpegを用意し `FFMPEG_PATH` に絶対パスを設定してください。画像・PDF用のsharp／Canvasも実行OSに合ったネイティブ依存関係が必要なので、別OSの `node_modules` はコピーせず、起動するOSでインストールします。日本語PDFサムネイルには日本語フォントを用意します。DockerイメージではNoto CJKを含めていますが、直接起動ではOS側のフォントを利用します。

直接起動はWindowsのLANサービスで運用し、LinuxはGitHub Actionsの実起動テスト対象です。

保存先は既定では従来配置です。0.14.0betaから、別の既存ディレクトリを`MEDIA_DIR`に指定してDB／鍵と本体を分離できます。既存環境は設定だけ切り替えず、[停止・バックアップ・移行手順](storage.md)に従ってください。

## 2. Dockerコンテナで起動する

0.14.0betaから`ghcr.io/suiren-kazutohashimoto/mirea:0.14.0beta`（linux/amd64）を配布します。ビルド不要の起動は`docker compose -f compose.release.yaml up -d`、停止は同じ`-f`で`down`です。[TrueNAS 25.04.2.6](truenas-25.04.md)には専用YAMLと設定対応表を用意しています。コンテナの管理更新はホスト側で行い、WebにDockerソケットを渡しません。以下はソースビルドの手順です。

ホストにNode.jsやpnpmを入れる必要はありません。DockerとCompose v2を用意し、ルートで実行します。

```sh
docker compose up --build -d
```

```sh
docker compose logs -f mirea
docker compose stop mirea
docker compose start mirea
```

`logs` はログ表示、`stop`／`start` は停止／再開です。コンテナを削除する場合の `docker compose down` でもnamed volumeのデータは残ります。`down -v` はデータを削除するので使用しないでください。

コンテナ内では常に `0.0.0.0:3000` で待ち受け、`/data` へ保存します。`.env` の `HOST`・`PORT` はホストへ公開するアドレスとポートに使います。例えば `PORT=3080` なら、直接起動もコンテナ起動もホストからは3080番で利用できます。

通常は `.env` の `DATA_DIR` ではなく `mirea-data` named volumeを使います。既存のコンテナデータを誤って切り替えないため、保存方式は自動変更しません。

## 3. 既存ホストディレクトリをコンテナでも使う

直接起動で使っていたDB・ファイルをそのまま使うための任意設定として、`compose.host-data.yaml` を用意しています。

1. 直接起動サーバーを停止し、データ領域全体をバックアップします。
2. `.env` の `DATA_DIR` に既存ディレクトリを指定します。相対パスはルート基準です。ディレクトリが実在することを確認してください。
3. コンテナのnodeユーザー（UID 1000）が読み書きできる権限を付けます。Linuxの直接起動ユーザーとUIDが異なる場合は特に確認してください。SELinux等のホスト側制限にも従ってください。
4. 次のコマンドで起動します。

```sh
docker compose -f compose.yaml -f compose.host-data.yaml up --build -d
```

この設定は `/data` の保存先をnamed volumeから指定ホストディレクトリへ置き換えます。パスのタイプミスで空のフォルダを自動作成しないよう、`create_host_path:false` にしています。[Composeのマージ規則](https://docs.docker.com/reference/compose-file/merge/)、[bind mount設定](https://docs.docker.com/reference/compose-file/services/#volumes)

停止・再開・ログ取得でも同じ `-f compose.yaml -f compose.host-data.yaml` を付けてください。通常設定だけの `up` に戻すと、元のnamed volumeへ戻り、別データが表示される点に注意してください。

**同じデータ領域を、直接起動とコンテナから同時に使わないでください。** SQLite・ファイル更新・変換キューは単一サーバープロセスで管理しています。起動方式の切替時は先に旧サーバーを停止します。分割受信中データも同じ領域にあれば、次の起動時に引き継がれます。処理中ジョブは再処理されます。

named volumeを使っていたコンテナから直接起動へ移る場合は、停止・バックアップ後に `/data` の全内容を新しい空のホストディレクトリへコピーし、それを `DATA_DIR` に設定します。SQLite本体だけでなくWAL・SHM、uploads、thumbnailsを同じ時点で扱います。元のボリュームは移行確認が終わるまで残してください。OSをまたぐ移行では、転送途中データの分割サイズは維持され、DBに保存していないインストール先やFFmpegのパスだけを環境ごとに設定し直します。

## 共通の注意と確認

初期値の127.0.0.1はホスト内からのみ接続可能です。外部公開は信頼できるHTTPS入口を置きます。`HOST=0.0.0.0` で直接公開する場合は、ファイアウォールとTLS終端を別途用意してください。Androidの接続先にはHTTPSが必要です。Cloudflareの利用条件や配信経路の制約は起動方式によらず同じです。[Cloudflare運用メモ](cloudflare.md)

```sh
pnpm test
pnpm build
pnpm test:startup
```

起動テストは別の一時領域で実際の `server/index.js` を起動し、Web配信・PDF分割転送・サムネイル・Range取得・再起動後の保持を確認します。通常の `data/` は変更しません。Dockerのビルド・非特権／読取専用root FS・FFmpeg変換・実アップロード・入れ子シリーズ・続き位置・コンテナ再作成後の鍵保持もCIの検査対象です。リリースタグでは全検査ジョブの正式成功後に、その検査済みイメージ自体を再ビルドせず公開します。このPCにはDockerがないため、コンテナの実行検証はCIで行います。
