# Mirea

Mireaは、本・動画・音楽を自分のサーバーに保存し、PCのブラウザーやAndroidから楽しむメディアライブラリです。本棚で共有相手を選び、シリーズで整理し、前回の続きから読んだり聴いたりできます。

この文書は **Mirea 1.0.0** に対応します。[対象版と検証範囲](docs/status.md)を確認し、配布物は[GitHub Releases](https://github.com/SUIREN-KazutoHashimoto/Mirea/releases)から取得してください。0.xベータ版からは、バックアップ後にサーバー、次にAndroidアプリの順で更新します。[正式版への移行手順](docs/operations/updates.md#ベータ版から正式版へ移るとき)

## どこから始めますか

| やりたいこと | 最初に読むページ |
| --- | --- |
| 自分のサーバーを初めて作る | [導入方法を選ぶ](docs/install/choose.md) |
| Dockerで起動する | [Docker Compose](docs/install/docker.md) |
| Docker DesktopまたはTrueNASを使う | [Docker Desktop](docs/install/docker-desktop.md) / [TrueNAS Custom App](docs/install/truenas.md) |
| Dockerを使わずに起動する | [Windows・Linuxの直接起動](docs/install/native.md) |
| すでに用意されたサーバーを使う | [最初のログインと閲覧](docs/user/first-steps.md) |
| フォルダの作品をまとめて登録する | [コンテンツを追加する](docs/user/uploads.md) |
| 外出先で読む・聴く・見る | [端末への保存](docs/user/downloads.md) / [プレイヤーの操作](docs/user/playback.md) |
| サーバーを管理する | [設定](docs/operations/settings.md) / [バックアップと復元](docs/operations/backup-restore.md) |
| 改修・フォークする | [開発環境](docs/development/setup.md) / [フォーク](docs/development/fork.md) / [設計書](docs/design/overview.md) |

全ページは[ドキュメント案内](docs/README.md)から探せます。

## できること

- PDF、EPUB、画像をまとめた本、動画、音声・音楽の登録と閲覧。
- 本棚ごとの共有と権限管理、入れ子のシリーズ、同じ種類の作品を集めたプレイリスト。
- ファイル・フォルダの一括取り込み、分割送信と再試行、送信とサーバー後処理の状況確認。
- 動画の画質選択、音楽・動画の連続再生、リピート、シャッフル、イコライザー。
- Androidのバックグラウンド再生・通知操作・PiP。Web/PWAはブラウザーが対応する機能を利用。
- 個人ごとの続き位置、端末への暗号化保存、最後のオンライン認可から7日間の閲覧。
- 一覧・表紙の保存、カスタムサムネイル、管理者向けのジョブ・再生成・バックアップ・診断。

対応形式、端末ごとの差、上限は[対応範囲](docs/reference/compatibility.md)で確認できます。端末への保存はサーバーのバックアップの代わりにはなりません。

## サーバーを用意する前に

Mireaは単一サーバーとローカルのSQLite・ファイル領域を使います。DockerコンテナとNode.js直接起動に対応します。コンテナにはLandlock ABI 3以上などの条件があり、Dockerが動くだけで必ず起動できるとは限りません。[導入方法の比較](docs/install/choose.md)で確認してください。

スマートフォンや別のPCから接続する場合は、端末が信頼できるHTTPS URLを用意します。初期状態のコンテナは同じPCからの確認用です。外部公開やネットワーク設定の変更は自動で行いません。

新規の空の環境には初期管理者 `admin@example.com` / `ChangeMe` が作られます。最初にログインしてメールアドレスとパスワードを両方変更します。既存ユーザーがいる環境には追加されません。具体的な操作は各導入手順にあります。

## 開発と設計

- [開発環境を作る](docs/development/setup.md)
- [構成と処理の設計](docs/design/overview.md)
- [データモデル](docs/design/data-model.md) / [API](docs/api.md)
- [テストの選び方と実行](docs/development/testing.md)
- [変更を提案する](CONTRIBUTING.md)
- [セキュリティ上の問題を報告する](SECURITY.md)

依存バージョンは[package.json](package.json)、[ロックファイル](pnpm-lock.yaml)、Android設定を正本とします。実データ・秘密鍵・個人の開発環境情報をリポジトリへ含めないでください。

## ライセンス

[Apache License 2.0](LICENSE)。依存ライブラリ、メディア処理ツール、フォントにはそれぞれのライセンスが適用されます。独自配布時の確認事項は[フォーク手順](docs/development/fork.md)にまとめています。
