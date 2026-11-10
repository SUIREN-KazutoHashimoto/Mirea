# Node.jsで直接起動する

Dockerを使わず、WindowsまたはLinuxでMireaサーバーを起動します。最初は同じPCのブラウザーだけから接続し、その後HTTPSを設定します。

対象: Mirea `2.0.0beta`。配布済みの版を使う場合は、その版のファイルと手順を組み合わせます。

## 1. ソフトウェアを用意する

| 必要なもの | バージョン・用途 |
| --- | --- |
| Node.js | 24.13.0以上の24.x。25以降はこの構成の対象外 |
| pnpm | 11.25.0。依存関係のインストール |
| FFmpeg / FFprobe | LinuxではOSのパッケージ。Windowsは依存関係の導入時に取得 |
| 日本語フォント | PDFの表紙に日本語を描く場合に必要 |
| Git | ソースをcloneする場合だけ必要 |

[Node.js公式配布](https://nodejs.org/en/download)から対応版を導入し、新しいターミナルを開きます。

```sh
node --version
npm install --global pnpm@11.25.0
pnpm --version
```

Nodeは `v24.x.x`、pnpmは `11.25.0` になれば次へ進みます。インストール権限の問題はNode/npmの配置先を確認し、Mireaサーバー自体を管理者として起動して回避しません。

LinuxのDebian/Ubuntu系ではOS管理者が次を導入します。他のディストリビューションは同等パッケージを使います。

```sh
sudo apt-get update
sudo apt-get install ffmpeg fontconfig fonts-noto-cjk
ffmpeg -version
ffprobe -version
```

Linuxの既定パスは `/usr/bin/ffmpeg` と `/usr/bin/ffprobe` です。別パスの信頼できるバイナリを使う場合は `FFMPEG_PATH` / `FFPROBE_PATH` を指定します。

## 2. 配布ファイルを手元に置く

[リリース一覧](https://github.com/SUIREN-KazutoHashimoto/Mirea/releases)で使う版を選びます。次のどちらか一方を使います。

| 選択 | ダウンロードするもの | 後で実行する操作 |
| --- | --- | --- |
| 完成品から起動する | `mirea-<版>-server.tar.gz` と同名の `.sha256` | 依存関係の導入と起動。Webのビルドは不要 |
| ソースから構築する | GitHubのSource code ZIP、またはGit clone | 依存関係の導入、Webのビルド、起動 |

### 完成品アーカイブを使う

完成品が添付されている版では、`server.tar.gz` と対応する `.sha256` を同じフォルダーへ保存します。以下は公開済み版のファイル名の例です。他の版を選んだ場合は両方のファイル名を読み替えます。

WindowsのPowerShellでは、ダウンロード先で次を実行します。

```powershell
$archive = 'mirea-2.0.0beta-server.tar.gz'
$expected = ((Get-Content "$archive.sha256" -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($actual -ine $expected) { throw 'SHA-256が一致しません。展開せず、取得元とファイルを確認してください。' }
tar -xf $archive
cd mirea-2.0.0beta-server
```

Linuxでは同じダウンロード先で実行します。

```sh
sha256sum -c mirea-2.0.0beta-server.tar.gz.sha256
tar -xf mirea-2.0.0beta-server.tar.gz
cd mirea-2.0.0beta-server
```

Linuxは最初の行が `OK` になったことを確認してから展開します。既存の設置先へ上書き展開せず、空の場所を使います。SHA-256は取得したファイルの一致確認です。配布元も公式Releaseであることを確認してください。

展開先には `server`、ビルド済み画面の `dist`、`package.json`、設定例などがあります。Node.js本体、`node_modules`、利用者データ、秘密鍵・証明書は含まれません。`web` や開発用ビルド設定は含まれないため、このアーカイブで `pnpm build` は実行しません。次の「3. 保存先を決める」へ進みます。

### ソースから構築する

選んだ版のSource code ZIPを展開し、`package.json` があるフォルダーを開きます。

Gitを使う場合の、公開済み固定版の例です。

```sh
git clone --branch v2.0.0beta --depth 1 https://github.com/SUIREN-KazutoHashimoto/Mirea.git mirea-server
cd mirea-server
```

既にソースを開いている場合はcloneを重ねず、そのフォルダーを使います。別OSで作った `node_modules` はコピーしません。

## 3. 保存先を決める

試用では設定ファイルなしでも動き、起動フォルダー内の `data` に保存します。継続利用はコードとデータを分けると更新しやすくなります。

`package.json` と同じフォルダーに `.env` という名前のテキストファイルを作ります。Windowsで `.env.txt` にならないよう、拡張子を表示して確認します。既存の `.env` は上書きしません。

Windowsの例:

```dotenv
HOST=127.0.0.1
PORT=3000
DATA_DIR=C:/Mirea/data
```

Linuxの例:

```dotenv
HOST=127.0.0.1
PORT=3000
DATA_DIR=/srv/mirea/data
```

保存先の親フォルダーを用意し、Mireaを起動する専用の一般ユーザーだけに必要な読み書き権限を与えます。システムの共有ディレクトリ全体の権限は変更しません。

アップロード上限などは、まず管理画面から変更します。`.env`に明示した項目はUIより優先されます。[設定の優先順位](../operations/settings.md)

## 4. インストールして起動する

`package.json` のあるフォルダーで実行します。PowerShellでも同じコマンドです。

完成品アーカイブを選んだ場合:

```sh
pnpm install --prod --frozen-lockfile
pnpm start
```

ソースZIPまたはGit cloneを選んだ場合:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

各行にエラーがないことを確かめてから次の行を実行します。`pnpm start` はターミナルを使用し続けます。閉じるとサーバーが停止するため、起動後も開いたままにします。

## 5. ログインして作品を開く

1. 同じPCで `http://localhost:3000` を開きます。
2. 空の新規環境なら `admin@example.com` / `ChangeMe` でログインします。
3. 設定からメールアドレスとパスワードを両方変更します。
4. 本棚を作成し、小さなPDFや音声を追加します。転送後に開けることを確認します。
5. スマートフォンでも使う場合は[HTTPS](https.md)を設定します。

停止はサーバーのターミナルで `Ctrl+C`、再開は同じフォルダーの `pnpm start` です。再起動後も同じアカウントと作品が見えれば保存先の確認ができています。

## 常時稼働と更新

サービス化は、OSのサービス管理機能で一般ユーザーとして `node` と `server/index.js` の絶対パスを起動します。自動再起動、ログ保存、停止方法を一緒に設定します。Webサービスへ管理者権限を与えません。リポジトリに含まれる環境限定の保守スクリプトは、汎用のサービスインストーラーではありません。

更新は[更新と切り戻し](../operations/updates.md)、バックアップは[バックアップと復元](../operations/backup-restore.md)を使います。コードだけを古く戻すとDBとの互換性を失う場合があります。

## エラーになった場合

- Nodeの版が違う：`node --version` と利用する実行ファイルを確認します。
- sharp / Canvas等のネイティブ依存が読めない：対象OSで `pnpm install --frozen-lockfile` を行ったか確認します。
- メディア処理だけ失敗：FFmpeg/FFprobeのパス、保存先・一時領域の空き容量、権限を確認します。
- 起動したが以前の作品が見えない：`DATA_DIR`、`.env`の場所、OS側の環境変数を確認します。データを追加・削除する前に正しい保存先へ戻します。

根拠: [package.json](../../package.json)、[起動設定](../../server/runtime.js)、[メディアバイナリ選択](../../server/media-binary.js)
