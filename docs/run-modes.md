# サーバーの起動方式と切り替え

対象: Mirea `1.0.0`。配布版を導入するときは、選択したリリースのファイルと文書を組み合わせてください。

初めて導入する場合は[起動方式を選ぶ](install/choose.md)から進みます。Mireaのサーバー機能はNode.js直接起動とコンテナ起動で共通です。保存先、HTTPS入口、更新の担当範囲が異なります。

| 起動方式 | 手順 | 更新する場所 |
| --- | --- | --- |
| LinuxとDocker Compose | [Docker](install/docker.md) | Dockerホスト |
| Windows/macOSのDocker Desktop | [Docker Desktop](install/docker-desktop.md) | Docker Desktop側 |
| TrueNAS Custom App | [TrueNAS](install/truenas.md) | Appsの設定 |
| Node.js直接起動 | [直接起動](install/native.md) | サーバーのコード配置先 |

## データを引き継いで方式を変更する

この操作は初回インストールとは別です。同じデータを旧サーバーと新サーバーから同時に開きません。SQLiteとメディアキューは単一サーバープロセスで管理します。

1. 現在のMirea版、保存先、公開URL、環境変数、実行ユーザーを記録します。
2. 転送とジョブを完了させ、旧サーバーを停止します。
3. [全体バックアップ](operations/backup-restore.md)を取り、設定・証明書も保管します。分離していればdata/media両方が必要です。
4. 新方式の実行ユーザーが必要なデータを読み書きできることを確認します。新方式にはまず同じMirea版を使い、移行と版更新を分けます。
5. 空の移行先へ全データをコピーするか、停止済みの既存保存先を明示的にマウントします。DBだけの移動では不十分です。
6. 新サーバーだけを起動し、アカウント・作品・表紙・続き位置・ダウンロードを確認します。
7. 旧データは確認とバックアップ完了まで残します。戻す場合も、新サーバーを停止してから対応するコード・データ・設定の組へ戻します。

公開URLが変わると、クライアントでは別サーバーとして扱われる場合があります。端末保存の再取得が必要になる可能性を含めて確認します。

## 既存ホストディレクトリをComposeで使う

[compose.host-data.yaml](../compose.host-data.yaml)は、`/data`をnamed volumeから既存ホストディレクトリへ変更する追加設定です。通常の新規導入に必須ではありません。

リリースのComposeと同じフォルダーへ追加設定を置き、`.env`の`DATA_DIR`へ既存の絶対パスを指定します。例のパスは自分の保存先に置き換えます。

```dotenv
DATA_DIR=/srv/mirea/data
```

データの停止・バックアップ・所有権確認後に実行します。

```sh
docker compose -p mirea -f compose.release.yaml -f compose.host-data.yaml config --quiet
docker compose -p mirea -f compose.release.yaml -f compose.host-data.yaml up -d --wait
```

追加設定の`create_host_path:false`は、パス間違いで空の保存先を作らないための保護です。設定を省くと別のnamed volumeを開くため、停止・起動・ログ取得でも同じプロジェクト名と`-f`の組み合わせを使います。

既にmedia分離している環境は、この例だけでは足りません。既存`MEDIA_DIR`も正しくマウントし、[識別ファイルを含む保存先仕様](storage.md)を維持してください。保存先の切り替えと分離の新規導入を同時に行わない方が切り分けしやすくなります。
