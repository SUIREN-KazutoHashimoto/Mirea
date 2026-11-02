# Mirea ドキュメント

最初から全部を読む必要はありません。サーバーを作る人は「導入」、作品を利用する人は「利用」、コードを改修する人は「開発と設計」から進んでください。

この資料はMirea 1.0.0に対応します。[対象版と検証範囲](status.md)を確認してください。過去の版名が付いたページは変更記録または現行ガイドへの案内であり、その版の挙動を調べる場合は対応するGitタグの資料を使います。

## 導入

1. [導入方法を選ぶ](install/choose.md) — Docker、Docker Desktop、TrueNAS、直接起動の条件を比較します。
2. 自分の環境の手順へ進みます。[Docker Compose](install/docker.md) / [Docker Desktop](install/docker-desktop.md) / [TrueNAS GUI](install/truenas.md) / [Windows・Linux](install/native.md)
3. [HTTPSと端末接続](install/https.md) — 別のPC・スマートフォンから接続します。
4. [最初のログインと閲覧](user/first-steps.md) — 最初の作品を開きます。
5. [バックアップと復元](operations/backup-restore.md) — 作品を増やす前に復元方法を確認します。

## 利用

| 目的 | ガイド |
| --- | --- |
| 接続・ログイン・PWAの導入 | [最初の操作](user/first-steps.md) |
| 本棚・シリーズ・プレイリストの整理 | [ライブラリ](user/library.md) |
| ファイル・フォルダの一括追加、取消と再試行 | [アップロード](user/uploads.md) |
| 本を読む、音楽・動画を再生する | [プレイヤー](user/playback.md) |
| 外出前の保存、容量と視聴期限 | [ダウンロード](user/downloads.md) |
| 共有・非公開本棚・閲覧記録・アカウント | [プライバシー](user/privacy.md) |
| 作品が見えない、送信が止まった、音が途切れる | [利用者向けの問題解決](user/help.md) |

## 運用

- [管理画面の設定](operations/settings.md) / [設定値の一覧](reference/configuration.md)
- [バックアップと復元](operations/backup-restore.md)
- [更新と切り戻し](operations/updates.md)
- [サーバーの問題解決](operations/troubleshooting.md)
- [保存先の分離](storage.md)
- [コンテナの保護と起動条件](container-security.md)
- [Cloudflareを経由する場合](cloudflare.md)
- [対応形式・プラットフォーム・機能の範囲](reference/compatibility.md)

## 開発と設計

| 読む順番 | 内容 |
| --- | --- |
| [開発環境](development/setup.md) | ソース入手、独立したデータ、Web/API/Androidの起動 |
| [全体設計](design/overview.md) | 各構成要素の責務とコードの入口 |
| [データモデル](design/data-model.md) / [スキーマ辞書](design/schema-reference.md) | DB・保存先・関連・削除と移行 |
| [API仕様](api.md) | 要求、応答、権限、状態、エラー |
| [送信とジョブ](design/upload-jobs.md) | 受付、後処理、並列実行、再試行、取消、復旧 |
| [再生](design/playback.md) / [書籍リーダー](design/books.md) | プレイヤー、先読み、連続再生、PDF・画像本・EPUB |
| [端末保存と同期](design/offline-sync.md) | カタログ、暗号文、期限、接続切替、進行度 |
| [セキュリティ](design/security.md) | 信頼境界、認証・権限、鍵、ログ |
| [Android](design/android.md) | WebView、ネイティブサービス、OSとの連携 |
| [設計判断](design/decisions.md) | 採用理由、制約、変更時の検討事項 |
| [フォーク](development/fork.md) | 自分用の改修と独自配布の違い、変更箇所 |
| [テスト](development/testing.md) | 自動テスト、画面確認、実機で確認する範囲 |
| [リリース](development/release.md) | 版、CI、APK署名、イメージ、更新情報 |

## 変更履歴と調査記録

- [リリース別の変更履歴](../RELEASE.md)
- [対象版と検証範囲](status.md)
- [Android更新の仕様](android-updates.md)
- [Play Protectの調査記録](security/play-protect.md)
- [文書の更新方法と公開情報の基準](development/documentation.md)

従来のページにも新しい案内へのリンクを残しています。詳細な仕様は設計書、日常の操作は利用ガイドを参照してください。
