# Docker Desktopで利用する

Docker DesktopではWindows/macOS上のLinux VMでMireaコンテナを動かします。画面からコンテナを管理できますが、Mireaの操作手順・保存先・起動保護は[DockerとCompose](docker.md)と共通です。

対象: Mirea `1.0.0`。すべてのDocker Desktop版・バックエンドの実機互換を保証していません。**Linux VMがLandlock ABI 3以上に対応していること**を起動時に確認します。

## 1. Docker Desktopを準備する

1. 自分のOSに合うDocker Desktopを[公式サイト](https://docs.docker.com/desktop/)から導入します。
2. WindowsではLinuxコンテナを選びます。WindowsコンテナモードではMireaのLinuxイメージは起動できません。
3. Docker Desktopを起動し、Engineが動作中になったことを確認します。
4. PowerShellまたはターミナルで `docker version` と `docker compose version` を実行します。

Windowsの対応OS・WSL要件・仮想化要件は[Windows向け公式導入手順](https://docs.docker.com/desktop/setup/install/windows-install/)で確認します。Windows ServerではDocker Desktopを前提にせず、対応Linuxホストまたは[Node.js直接起動](native.md)を選びます。

## 2. CPUと起動保護の条件を確認する

配布イメージは `linux/amd64` です。ARM機でのエミュレーション、特にApple Siliconでのメディア変換とLandlockは別の互換条件になります。`--platform=linux/amd64`を付けるだけで対応済みとは判断しません。

まず本番データをマウントせずに、次の起動確認ができます。これは一時コンテナにのみ適用し、DBを起動しません。

```sh
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 ghcr.io/suiren-kazutohashimoto/mirea:1.0.0 /usr/local/bin/node -e "console.log('Mirea launcher OK')"
```

`Mirea container sandbox enforced` と `Mirea launcher OK` が出れば、このVMで起動保護の確認を通っています。イメージ既定のEntrypointを通すことが重要です。

`Landlock ABI >= 3 required` やseccompエラーなら、そのバックエンドでは現状起動できません。Docker Desktop/WSLの対応した更新を確認するか、対応Linuxサーバー・Node.js直接起動へ切り替えます。`--privileged`、seccomp無効化、Entrypoint変更で検査を迂回しないでください。

## 3. Mireaを起動する

[DockerとComposeの手順2以降](docker.md#2-配布ファイルを保存する)を実行します。起動するとDocker DesktopのContainers画面にComposeプロジェクト `mirea` が表示されます。

- `http://localhost:3000` はDocker Desktopを動かすPCで開きます。
- 初期管理者のメールアドレスとパスワードを変更します。
- 最初はnamed volumeを使います。Windowsの共有フォルダーや同期フォルダーへSQLiteを直接置く構成は避けます。
- スマートフォンへ接続を広げる場合は、Docker Desktopとホストの両方のネットワーク境界を確認し、[HTTPS](https.md)を用意します。

## 4. データを守って管理する

Docker Desktopの終了・PCスリープ中は、別端末からサーバーに接続できません。常時利用する場合は、稼働時間と省電力設定を運用として決めます。

コンテナを停止してもnamed volumeのデータは残ります。コンテナのイメージ保存だけでは、ボリューム内の作品・DB・鍵は保存されません。バックアップは[Mireaのバックアップ手順](../operations/backup-restore.md)で取得します。Docker Desktop自体の移行・復旧は[公式バックアップ案内](https://docs.docker.com/desktop/settings-and-maintenance/backup-and-restore/)も確認してください。

Docker Desktopの「Factory reset」、VMディスク削除、ボリューム削除をする前に、バックアップをPC外へ保存します。更新やトラブル調査のために初期化する必要は通常ありません。

次へ: [DockerとCompose](docker.md)
