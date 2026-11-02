# Linuxコンテナの起動保護

対象: Mirea `1.0.0`。

Mireaの配布イメージは、Node.jsの前に非rootランチャーを実行します。DockerのGUIで指定できる保護項目が異なる場合にも、アプリケーションと子プロセスの制約を適用します。通常のComposeではDocker側の読取専用root、capability削除、no-new-privilegesも併用します。

初めて導入する人は[Docker](install/docker.md)、[Docker Desktop](install/docker-desktop.md)、[TrueNAS](install/truenas.md)の手順を使ってください。このページは起動条件と既存の互換設定を調べるための仕様です。

## 必須条件と処理順

1. 通常のDocker seccompフィルターが有効であること。特権・seccomp無効化は使いません。
2. UID/GIDがともに非0で、有効・許可・継承・ambient capabilityが空であること。
3. 余分な継承FDを閉じ、`PR_SET_NO_NEW_PRIVS`を設定します。
4. Landlock **ABI 3以上**を要求します。カーネルの版番号だけでなく有効LSMとsyscallの利用可否が必要です。未対応・無効・拒否の場合は終了コード78で止まり、制約を外して続行しません。
5. 単一スレッドのランチャーがLandlockを適用し、Node.jsへexecします。以後のスレッド、画像ワーカー、FFmpegなどにも継承します。
6. 専用HTTPS事前検査を有効にしている場合は、その検査を行ってからDBを開きます。

イメージのEntrypointは`/usr/local/bin/mirea-launch`、Commandは`/usr/local/bin/node /app/server/container-entry.mjs`です。GUIで上書きしません。`docker exec`など、Docker管理者が外部から直接起動した別プロセスまでこのランチャーで保護するものではありません。

LandlockのABIとカーネル要件は[Linux公式資料](https://docs.kernel.org/userspace-api/landlock.html)、権限昇格防止は[no_new_privs](https://docs.kernel.org/userspace-api/no_new_privs.html)を参照してください。

## 許可される操作

| 対象 | 制約 |
| --- | --- |
| 書き込み | `/data`、`MEDIA_DIR=/media`の場合の`/media`、`/tmp`配下。例外は`/dev/null`への書き込み |
| 実行 | root所有の`/usr`と`/app`内。データ領域や`/tmp`の生成バイナリを直接実行しない |
| 新規の特殊ファイル | symlink、FIFO、UNIXソケット、デバイスノードの作成を許可しない |
| SQLite一時ファイル | ランチャーが`SQLITE_TMPDIR=/tmp`を設定 |
| コンテナ内の保存先 | `DATA_DIR=/data`。分離時は`MEDIA_DIR=/media` |

SQLiteが大量の削除や並べ替えに一時ファイルを使うため、`/tmp`にも空きが必要です。保護外の別フォルダーへ書き込み先を広げるのではなく、一時領域の容量を確認します。

Landlockはこの構成で読み取りやネットワークを制限しません。chmod/chownなどすべてのメタデータ操作を制限するものでもありません。Dockerの読取専用root FSと完全に同じ仕組みではないため、追加の書き込みマウントを避け、実行コードはroot所有のままにします。

Mirea専用の必要な保存先だけをマウントし、Dockerソケット、ホスト全体、他アプリの保存先、管理資格情報を渡しません。データ内スクリプトをインタープリターに渡す全ての手法を遮断するサンドボックスでもありません。

## TrueNAS HTTPS事前検査

`MIREA_TRUENAS_PREFLIGHT=1`は、特定の固定配置・証明書ピンを検査する既存の互換機能です。TrueNAS導入の必須条件ではありません。新規の一般的な構成には[HTTPSプロキシ](install/https.md)を使えます。

この機能を既に使う環境の調査・保守では、次の契約を維持します。秘密鍵の内容を環境変数へ入れません。

| 変数 | 内容 |
| --- | --- |
| `DATA_DIR` / `MEDIA_DIR` | `/data` / `/media` |
| `MIREA_STORAGE_GROUP_ID` | 二つの保存先の実GID。実行GIDとは別でもよい |
| `MIREA_INSTALL_ID` | インストール専用の16〜80文字の固定英数字・ハイフン |
| `HTTPS_KEY_FILE` | `/data/keys/tls/server-key.pem` |
| `HTTPS_CERT_FILE` | `/data/keys/tls/server-chain.pem` |
| `HEALTHCHECK_CA_FILE` | `/data/keys/tls/suiren-root-ca.pem` |
| `HEALTHCHECK_TLS_SERVER_NAME` | サーバー証明書のDNS名 |
| `MIREA_TLS_IP` | 同じ証明書のIP SAN |
| `MIREA_TLS_ROOT_SHA256` | ルート証明書のDER SHA-256、64桁hex |
| `MIREA_TLS_LEAF_SHA256` | サーバー証明書のDER SHA-256 |
| `MIREA_TLS_SPKI_SHA256` | サーバー公開鍵のSPKI DER SHA-256 |

`suiren-root-ca.pem`は実装との互換性のために残る歴史的な固定**ファイル名**です。実際に使用すべきCAの名称や、特定運営者のCAを指定する意味ではありません。新しい任意ファイル名に置き換えると現行検査に通らないため、仕様を偽って読み替えないでください。

保存先は実行UIDと指定保存先GIDが所有し、other権限なしにします。`keys`と`keys/tls`は実行UID/GID所有・0700です。秘密鍵は0600、二つの公開PEMは0644で、通常ファイル・リンクなし・同じ実行UID/GID所有を要求します。検査は権限を自動変更しません。

チェーンはleafとrootの2証明書です。CA制約、root自己署名、leaf署名、serverAuth専用EKU、DNS/IP、期限、秘密鍵との一致と三つの指紋を検証します。オンライン失効確認を保証するものではありません。

初回はdataに`keys/tls`の3つのPEMだけがあり、mediaが空であることを要求します。検査後に0600の`.truenas-mirea-bootstrap.json`を排他的に作成します。以後は同じ導入ID、証明書、実行IDの記録を確認して再起動します。既存DBの自動採用や旧schemaVersion 1からの自動変換は行いません。

証明書交換・ID変更・既存環境への適用は、停止・全バックアップ・新旧情報のレビューが必要です。エラー時にDBや識別ファイルを消して初期化しません。通常の版更新では導入ID・証明書・記録を維持します。

## 起動しない場合と検証の範囲

ログの最初の失敗理由を確認し、Landlock、UID/GID、capability、マウント、TLSを分けて調べます。未対応の基盤では対応するLinux環境または[Node.js直接起動](install/native.md)を選びます。Entrypointの迂回や特権化で強行しません。

リポジトリの検査コードは[サンドボックス検査](../scripts/check-container-sandbox.mjs)、[コンテナ検査](../scripts/check-container.mjs)、[事前検査テスト](../tests/truenas-preflight.test.js)です。これらのCI結果は、利用者のDocker Desktopバックエンド、NAS GUI、ファイルACL、HTTPSプロキシの検証を代わりにはしません。導入先でも起動・ヘルスチェック・停止再開を確認してください。
