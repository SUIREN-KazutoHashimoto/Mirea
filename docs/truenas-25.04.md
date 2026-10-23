# TrueNAS 25.04.2.6 Custom App — Mirea 0.14.0beta

この手順は導入計画です。TrueNASへのインストール・設定変更・既存WinVAI01からのデータ移行は自動実行しません。対象はDockerベースのAppsを持つTrueNAS **25.04.2.6 / x86-64**。ARM版・GPUトランスコード・複数レプリカは提供しません。

## 配布物と推奨構成

- イメージ: `ghcr.io/suiren-kazutohashimoto/mirea:0.14.0beta`（linux/amd64）。`latest`は使いません。
- [リリース](https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/tag/v0.14.0beta)の`mirea-0.14.0beta-container.json`でコミット・レジストリdigestを確認し、可能なら`image`をそこに記載した`ghcr.io/…@sha256:…`へ固定します。
- DockerがGHCRへ接続できない環境用に、同じ検証済みイメージの`container-linux-amd64.tar.gz`とSHA-256も配布します。導入操作はTrueNASのサポート範囲に従ってください。
- 推奨は [Compose YAML](../deploy/truenas/compose.yaml) を使うCustom App。NASのローカルSSDデータセットを`/data`、大容量側を`/media`へそれぞれマウントし、HTTPSは別のリバースプロキシで終端します。

| 項目 | 初期推奨値 |
| --- | --- |
| アプリ名 | `mirea` |
| 実行UID / GID | **1000 / 1000**（root不可） |
| CPU / メモリー | 2コア / 4 GiB。長尺・高解像度動画は4コア / 8 GiBから調整 |
| PID / 一時RAM領域 | 256 / `/tmp` 256 MiB |
| 状態・DB・鍵・表紙 | `/mnt/SSD_POOL/apps/mirea/state` → `/data`、読み書き可 |
| 本体・原本・HLS | `/mnt/MEDIA_POOL/apps/mirea/media` → `/media`、読み書き可 |
| コンテナ内部ポート | TCP 3000 |
| ホスト側ポート | TCP 13000、初期は127.0.0.1限定 |
| 再起動 / 停止猶予 | unless-stopped / 2分 |
| ログ | json-file、10 MiB × 3 |
| セキュリティ | 読取専用root FS、cap_drop ALL、no-new-privileges、特権・Host Networkなし |

資源値はMireaの運用開始用の目安で、NAS上での実測保証ではありません。変換はソフトウェアH.264＋AACです。GPU割当だけでは高速化しません。稼働中ジョブ・CPU・RAM・空き容量を見て調整します。

## 1. 保存先を先に作る

1. Appsのプールを設定済みか確認します。例の`SSD_POOL`と`MEDIA_POOL`は実際のプール名に必ず置換します。
2. Mirea専用のローカルZFSデータセット`apps/mirea/state`と`apps/mirea/media`を作成。新規ならGeneric/POSIXの専用データセットを推奨し、実行UID 1000 / GID 1000に読み書きとディレクトリ通過を許可します。親ディレクトリの通過権限も必要です。
3. 既存UID/GIDの所有者を不用意に変更せず、必要な権限だけ付与します。`chmod 777`、既存共有への強制ACL適用、NAS全体の権限変更は行いません。GUIのCustom User初期値568ではなく1000へ明示変更します。
4. このデータセットを一般利用者向けSMB共有にしないでください。DB・鍵・詳細生ログを含みます。SQLite/WALの保存先にSMB/NFSマウントを使用しません。

`/data`はDB（WAL/SHMを含む）・暗号化ダウンロード鍵・詳細記録・表紙・プレビュー、`/media`は原本・本体・HLS・転送途中データを保持します。[分離・移行・復旧の詳細](storage.md)を先に確認してください。既存0.13.0以前の環境は新YAMLをそのまま貼り付けず、停止・全バックアップ・コピー専用ツールで移行してから2マウントに切り替えます。**DBだけのバックアップでは復旧できません**。原本は既定で保持するため、容量は原本＋派生動画＋履歴＋スナップショット余裕で見積もり、空き容量を監視します。

## 2. YAMLで追加（推奨）

25.04ではApps → Discover Apps → 右上のメニュー → **Install via YAML** からCustom Appを追加できます。アプリ名を`mirea`にして、[deploy/truenas/compose.yaml](../deploy/truenas/compose.yaml)の内容を貼り付けます。[TrueNAS 25.04公式画面説明](https://www.truenas.com/docs/scale/25.04/scaleuireference/apps/installcustomappscreens/)

インストール前に変更・確認する点:

- 2つの`source`の`SSD_POOL`／`MEDIA_POOL`を実在する専用データセットへ変更。`create_host_path:false`は誤ったパスで空の保存先を作らないための保護です。
- 同じNASホスト上のプロキシが127.0.0.1:13000へ接続する構成が初期値です。**別コンテナ内の127.0.0.1はNAS自身ではありません**。別コンテナなら明示した私設ネットワークで接続するか、NASのLANアドレスへ限定bindし、プロキシだけが到達できるファイアウォールを用意します。
- プロキシが別PCの場合もNASの特定LANアドレスへ変更し、13000番へ直接クライアントを接続させません。`0.0.0.0`による不用意な全面公開やルーターのポート開放は不要です。
- `CORS_ORIGINS=https://localhost`はAndroid同梱画面用です。通常のWebは同一オリジンです。任意オリジン・`*`は追加しません。
- 新規登録は初回だけ`ALLOW_REGISTRATION=true`。LAN境界の内側で自分のアカウントを作成したら`ALLOW_REGISTRATION=false`に変更して再起動します。初期管理者パスワードはありません。
- 管理者はログインした本人の`/api/v1/auth/me`のユーザーUUIDを確認し、`SERVER_ADMIN_USER_IDS`へ設定します（メールアドレスではありません）。既存データ移行時は現在の管理権限を確認して引き継ぎます。

イメージ内にAPK署名秘密鍵・証明書・利用者データはありません。Android APKはリリースから取得できます。既存の署名済み更新バンドルを別途配信する場合は公開APK・署名済みmanifest・公開鍵だけを読み取り専用で配置し、接続先URLに合ったmanifestをオフライン署名者が発行してください。秘密署名鍵をNASのWebサービスへ持たせません。

## 3. GUIのCustom Appを使う場合の対応表

YAMLのほうが安全設定を再現しやすいため推奨です。GUIを使うなら上の値に加えて次を確認します。

| 25.04 GUI項目 | 設定 |
| --- | --- |
| Image Repository / Tag | `ghcr.io/suiren-kazutohashimoto/mirea` / `0.14.0beta` |
| Entrypoint / Command | 上書きしない |
| Custom User | 有効、User ID 1000 / Group ID 1000 |
| Privileged / Host Network | 無効 / 無効 |
| Disable Builtin Healthcheck | 無効（イメージの検査を使用） |
| Storage Type / Mount Path | Host Pathを2件、状態用 `/data`・本体用 `/media`、いずれもRead Onlyは無効 |
| 環境変数 | YAMLのenvironmentを転記、HOST=0.0.0.0 / PORT=3000 / DATA_DIR=/data / MEDIA_DIR=/media |
| CPU / Memory | 2 / 4096 MiBから開始 |

GUIがホストbindアドレス・cap_drop・読取専用root FS等を表現できない場合は、保護を省かずYAML方式を使います。UID/GID・ポート・Host Path等の名称は[25.04公式リファレンス](https://www.truenas.com/docs/scale/25.04/scaleuireference/apps/installcustomappscreens/)に対応します。

## 4. HTTPSとAD CS

Android・Service Worker・暗号化ダウンロードには信頼されたHTTPS入口を用意します。AD CS `SUIREN-RootCA`で、**NAS側MireaサービスのDNS名/SANに合う新しいサーバー証明書**を発行し、HTTPSプロキシへ設置します。ルートCA公開証明書は端末で信頼させます。WinVAI01の秘密鍵やCA秘密鍵を流用・コンテナへ同梱しません。証明書検証を無効化しないでください。

プロキシは元のHost・Range・Content-Range・ストリーミングを保持し、アップロード1要求8 MiBを超える上限（例16 MiB以上）と、低速回線に適したタイムアウトを設定します。Mireaのアセット合計上限は既定2 GiBで、分割1要求の上限とは別です。HTTPSと内部HTTPで無限リダイレクトさせないでください。

Cloudflareを使う場合は[配信経路・利用条件の注意](cloudflare.md)も確認します。分割転送はCDNの動画利用条件を回避する手段ではありません。今回のWinVAI01のLAN限定公開は変更しません。

## 5. 導入後の確認

- Appsのコンテナがhealthyになり、`/api/health`が`status:ok / version:0.14.0-beta`であること。
- 信頼されたHTTPSからログイン、本棚・シリーズ階層・サムネイルを確認。
- 小さなPDF／動画／音声をテスト専用本棚へアップロードし、ジョブ完了、再生・読書・シーク・保存・再接続を確認。
- アプリを停止・再開してもアカウント・続き位置・ダウンロード鍵が変わらないこと。
- 管理者でないアカウントに管理メニューが出ず、他人の本棚・個人詳細ログを取得できないこと。

CIはLinuxコンテナの変換・再作成・データ／鍵保持を検査しますが、実機TrueNASのUI・権限・プロキシまでは検証しません。

## 6. バックアップ・更新・復帰

1. 実行中のアップロード／ジョブが終わったことを確認してMireaアプリを停止。
2. **DATA_DIR・MEDIA_DIRの両方の全体＋Custom App YAML・環境変数＋プロキシ設定／証明書を保護された場所へバックアップ**。停止状態のZFSスナップショットと別媒体への複製を推奨します。管理画面のメタデータのみのバックアップはメディアを含みません。
3. 新版のリリースノート・SHA-256・digestを確認し、同じHost Pathのままimageの版/digestだけを変更して起動。
4. 上記の導入後確認を実施。Mireaの管理画面からDocker更新は実行しません。Dockerソケット・NAS管理資格情報・特権をWebへ与えないでください。
5. 不調時は停止して、**旧イメージ＋更新前データ／設定の対応した組**を復元。新DBに旧サーバーを当てるダウングレードや、旧新サーバーから同じデータを同時に開く運用はしません。

0.14.0betaのDBはv17のままです。今後の移行に備えて上記を毎回行います。App削除時もデータセットを削除しないでください。`docker compose down -v`は禁止です。

WinVAI01から移行する場合も最初に旧サービスを停止して全データをコピーします。同じHTTPSオリジンを維持できない場合、ブラウザー／アプリの端末内保存はサーバー別管理のため再接続・再取得が必要になる場合があります。移行検証が済むまで旧データを保持します。

SQLiteのローカル保存の根拠: [WALの制約](https://sqlite.org/wal.html)。GHCRのアクセス設定: [Container Registry公式仕様](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
