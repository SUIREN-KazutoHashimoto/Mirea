# TrueNAS Custom Appの導入案内

TrueNAS 25.04系の手順は、他の導入方法と同じ構成で読めるよう[TrueNAS Custom Appへ導入する](install/truenas.md)へ移しました。特定の運営環境ではなく、汎用的な導入例です。

| 目的 | 参照先 |
| --- | --- |
| 保存用データセット、UID/GID、GUI入力 | [新しいTrueNAS手順](install/truenas.md) |
| Docker側の保護を指定するCompose例 | [deploy/truenas/compose.yaml](../deploy/truenas/compose.yaml) |
| data/media分離と既存環境からの移行 | [保存先](storage.md) |
| プロキシ、証明書、Android接続 | [HTTPS](install/https.md) |
| Landlockと専用HTTPS事前検査 | [コンテナ起動保護](container-security.md) |
| 固定タグ、stable、beta | [コンテナチャネル](container-channels.md) |

## 6. バックアップ・更新・復帰

既存リンクの参照先です。手順は[バックアップと復元](operations/backup-restore.md)、[更新と復帰](operations/updates.md)を使ってください。

Host Pathの自動バックアップを前提にせず、停止時点を揃えたdata/media、App設定、環境変数、プロキシと証明書を保管します。Appの削除や再作成で保存先を削除しません。Custom Appの表示用バージョンとMirea本体の版は別なので、実行中の版はMireaの設定または`/api/health`で確認します。
