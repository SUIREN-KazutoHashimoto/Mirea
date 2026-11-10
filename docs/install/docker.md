# DockerとComposeでサーバーを起動する

配布済みコンテナを使い、手元のPCまたはLinuxサーバーでMireaを起動します。Node.jsやpnpmをホストへ入れる必要はありません。空の新規環境を対象とします。既存データの移行は[保存先の分離](../storage.md)を先に読んでください。

対象: Mirea `2.0.0beta`。以下は固定タグ`2.0.0beta`の例です。GitHub Releasesで公開状態と配布物を確認してから導入してください。

## 1. 必要なものを確認する

- Docker EngineとCompose v2。OS別の導入は[Docker公式手順](https://docs.docker.com/engine/install/)を利用します。
- Linux/amd64の実行環境。配布イメージはARM64版ではありません。
- Landlock ABI 3以上が有効なLinuxカーネルと、Docker標準seccompフィルター。[保護の詳細](../container-security.md)
- Mirea専用の保存容量。Dockerのボリュームを保存するディスクにも空きが必要です。

ターミナルで次の2行を実行します。

```sh
docker version
docker compose version
```

DockerのClientとServerの情報、およびComposeのバージョンが表示されれば次へ進みます。`Cannot connect to the Docker daemon` の場合はDockerを起動し、利用権限を確認します。Docker管理権限をMireaのWebサービスへ渡す必要はありません。

## 2. 配布ファイルを保存する

1. [GitHub Releases](https://github.com/SUIREN-KazutoHashimoto/Mirea/releases)で利用するリリースを開きます。
2. `compose.release.yaml` をダウンロードします。データも分離する新規導入なら、同じリリースの `compose.storage.yaml` も保存します。
3. 自分が管理できる専用フォルダーを作り、そこへ置きます。例はLinuxなら `~/mirea-server`、Windowsなら `C:\Mirea\server` です。
4. そのフォルダーでターミナルを開きます。エクスプローラーの「ターミナルで開く」も使えます。

以下の例では、Composeプロジェクト名を `mirea` に固定します。フォルダー名を変えても同じボリュームを選べるよう、日常の操作でも `-p mirea` を付けます。

## 3. 起動前の設定を確認する

`compose.release.yaml` をテキストエディターで開きます。

| 項目 | 最初の設定 |
| --- | --- |
| `image` | 選択したリリースの固定タグ。例 `ghcr.io/suiren-kazutohashimoto/mirea:2.0.0beta` |
| `user` | `1000:1000`。rootへ変更しない |
| `host_ip` | `127.0.0.1`。まずホストPC内だけで開く |
| `published` | `3000`。他のサービスと重なる場合だけ空いている番号へ変更 |
| `volumes` | 基本設定は `mirea-data:/data`。手順4で分離構成を選ぶ場合は追加設定で `mirea-media:/media` も使用 |
| `entrypoint` / `command` | 追加・変更しない |

2.0.0betaのComposeは、次の設定を環境変数として渡します。管理画面から変更したい項目は、**その項目の行を `environment` から削除してから**起動します。省略時にもMireaの既定値があります。

```yaml
MAX_UPLOAD_BYTES: ${MAX_UPLOAD_BYTES:-2147483648}
UPLOAD_CHUNK_BYTES: ${UPLOAD_CHUNK_BYTES:-8388608}
ALLOW_REGISTRATION: ${ALLOW_REGISTRATION:-true}
ANALYTICS_ENABLED: ${ANALYTICS_ENABLED:-true}
```

ここに値を残す場合は、管理画面に環境変数による上書きが表示されます。`.env`の値を空にするだけではComposeの既定値が使われるため、UI管理へ移行できません。[設定の優先順位](../operations/settings.md)

`read_only`、`cap_drop`、`no-new-privileges`、`tmpfs`は削除しません。特権モード、Dockerソケット、ホスト全体のマウントも追加しません。

## 4. 取得して起動する

**初回起動前に、A（通常の単一保存先）かB（最初からdata/mediaを分離）のどちらか一方を選びます。両方を順番に実行しません。** PowerShellとLinux/macOSのシェルで、同じコマンドを使えます。

すでにAで一度でも起動した保存先をBへ変える場合は、以下の新規導入コマンドを使わず、[停止・バックアップ・保存先移行](../storage.md#既存の単一保存先から分ける)を先に行ってください。設定だけを切り替えると保存方式の不一致で起動を拒否します。識別ファイルやDBの削除で回避しません。

### A. 通常の単一保存先で初めて起動する

DB・作品・鍵を一つの `mirea-data` ボリュームへ保存します。

```sh
docker compose -p mirea -f compose.release.yaml config --quiet
docker compose -p mirea -f compose.release.yaml pull
docker compose -p mirea -f compose.release.yaml up -d --wait
docker compose -p mirea -f compose.release.yaml ps
```

Aを選んだ場合は、起動確認後に手順5へ進みます。Bのコマンドは実行しません。

### B. 最初からdata/mediaを分離して起動する

まだMireaを起動していない、空の新規保存先を対象にします。DB・鍵などを `mirea-data`、作品本体などを `mirea-media` ボリュームへ保存します。最初の検査・取得・起動から、すべてのコマンドに追加設定を指定します。

```sh
docker compose -p mirea -f compose.release.yaml -f compose.storage.yaml config --quiet
docker compose -p mirea -f compose.release.yaml -f compose.storage.yaml pull
docker compose -p mirea -f compose.release.yaml -f compose.storage.yaml up -d --wait
docker compose -p mirea -f compose.release.yaml -f compose.storage.yaml ps
```

### 起動結果を確認する

`config --quiet` は構文検査です。エラーが出たら起動せず、インデントや変更した値を確認します。取得には初回だけ時間がかかります。最後の一覧で `mirea` が稼働し、ヘルスチェックが `healthy` になれば起動完了です。

選んだプロジェクト名と `-f` の組み合わせを記録し、停止・再開・ログ取得・更新にも同じものを使います。

## 5. 最初にログインする

1. サーバーを動かしたPCのブラウザーで `http://localhost:3000` を開きます。別のPCの `localhost` は別のPC自身を指します。
2. 空の新規環境では `admin@example.com` / `ChangeMe` でログインします。
3. 設定でメールアドレスとパスワードを両方変更します。片方が初期値のままだと管理操作は制限されます。
4. テスト用の本棚を一つ作成し、小さなPDFなどを追加して開きます。
5. 複数人で使う場合は一般ユーザーを用意し、必要な本棚だけを共有します。サーバー管理者権限と本棚の閲覧権限は別です。

スマートフォンから使う場合は、続けて[HTTPS接続](https.md)を設定してください。LANのIPアドレスへのHTTP接続ではAndroidアプリや端末保存の条件を満たしません。

## 6. 停止と再開

手順4でAを選んだ場合:

```sh
docker compose -p mirea -f compose.release.yaml stop mirea
docker compose -p mirea -f compose.release.yaml start mirea
```

手順4でBを選んだ場合:

```sh
docker compose -p mirea -f compose.release.yaml -f compose.storage.yaml stop mirea
docker compose -p mirea -f compose.release.yaml -f compose.storage.yaml start mirea
```

停止してもボリュームのデータは残ります。`down -v`、Docker Desktopのボリューム削除、`docker volume prune` は保存データを失うため、通常の停止・更新に使いません。

## 起動しなかった場合

手順4でAを選んだ場合:

```sh
docker compose -p mirea -f compose.release.yaml logs --tail 60 mirea
```

手順4でBを選んだ場合:

```sh
docker compose -p mirea -f compose.release.yaml -f compose.storage.yaml logs --tail 60 mirea
```

- `Landlock ABI >= 3 required`：ホスト側の条件不足です。カーネル番号だけでなく有効なLandlockとsyscall利用可否が必要です。[Docker Desktopの注意](docker-desktop.md)も確認します。
- `permission denied`：実行UID/GIDと、マウント先の所有者・権限を確認します。特権化では解決しません。
- ポート競合：既存のサービスを調べ、公開ポートだけを変更します。内部の3000番は維持します。
- ログイン画面が出るがアカウントが消えたように見える：Composeプロジェクト名、`-f`の組み合わせ、ボリュームが前回と同じか確認します。新しいDBへデータを作る前に止めます。

次へ: [HTTPS](https.md) → [バックアップ](../operations/backup-restore.md) → [更新](../operations/updates.md)
