# TrueNAS 25.04.2.6 Custom App — Mirea

この手順は導入計画です。TrueNASへのインストール・設定変更・既存WinVAI01からのデータ移行は自動実行しません。対象はDockerベースのAppsを持つTrueNAS **25.04.2.6 / x86-64**。ARM版・GPUトランスコード・複数レプリカは提供しません。

## 配布物と推奨構成

- イメージ: `ghcr.io/suiren-kazutohashimoto/mirea:0.15.3beta`（版番号固定の例、linux/amd64）。更新追従には `:beta`、初回正式版の公開後は `:stable` も使用できます。[チャネルの公開条件と運用](container-channels.md)を確認してください。`latest`は使いません。Landlock ABI 3以上が有効なホストが必須です。
- [リリース](https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/tag/v0.15.3beta)の`mirea-0.15.3beta-container.json`でコミット・レジストリdigestを確認します。固定運用なら`image`をそこに記載した`ghcr.io/…@sha256:…`へ固定できます。
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

0.15.1beta以降はGUIからも、イメージ内の非root起動ランチャーを使って導入できます。[保護の範囲・必須条件・HTTPS事前検査](container-security.md)を先に確認してください。これはYAMLのDocker保護設定そのものを再現する方式ではありません。

| 25.04 GUI項目 | 設定 |
| --- | --- |
| Image Repository / Tag | `ghcr.io/suiren-kazutohashimoto/mirea` / 固定運用は`0.15.3beta`、追従運用は`beta`または正式版公開後の`stable` |
| Entrypoint / Command | 上書きしない |
| Custom User | 有効、User ID 1000 / Group ID 1000 |
| Privileged / Host Network | 無効 / 無効 |
| Capabilities Add | 空。追加しない |
| Disable Builtin Healthcheck | 無効（イメージの検査を使用） |
| Storage Type / Mount Path | Host Pathを2件、状態用 `/data`・本体用 `/media`、いずれもRead Onlyは無効 |
| 環境変数 | YAMLのenvironmentを転記、HOST=0.0.0.0 / PORT=3000 / DATA_DIR=/data / MEDIA_DIR=/media |
| CPU / Memory | 2 / 4096 MiBから開始 |
| `/tmp` | tmpfs、256 MiB（GUIで指定可能な場合） |

GUIはcap_drop・読取専用root FS・no-new-privilegesを指定できませんが、イメージのランチャーはNode開始前にno_new_privsとLandlockを強制します。適用できない場合はデータを初期化せず停止します。Entrypointを迂回したり特権で起動させないでください。ホストbindは対象のLAN IPを明示し、全インターフェースへの公開を避けます。

直接HTTPSを使う新規導入では、`MIREA_TRUENAS_PREFLIGHT=1`と[事前検査の全変数](container-security.md#truenas-https事前検査)を追加します。証明書と実行IDはそのNASで用意したものを使い、秘密鍵はHost Path内だけに置きます。初回の空領域検査は既存データを消す指示ではありません。初回アカウントは新しく登録し、リセット前のユーザーUUIDを管理者設定へ流用しません。

UID/GID・ポート・Host Path等の名称は[25.04公式リファレンス](https://www.truenas.com/docs/scale/25.04/scaleuireference/apps/installcustomappscreens/)に対応します。

## 4. HTTPSとAD CS

Android・Service Worker・暗号化ダウンロードには信頼されたHTTPS入口を用意します。AD CS `SUIREN-RootCA`で、**NAS側MireaサービスのDNS名/SANに合う新しいサーバー証明書**を発行し、HTTPSプロキシへ設置します。ルートCA公開証明書は端末で信頼させます。WinVAI01の秘密鍵やCA秘密鍵を流用・コンテナへ同梱しません。証明書検証を無効化しないでください。

プロキシは元のHost・Range・Content-Range・ストリーミングを保持し、アップロード1要求8 MiBを超える上限（例16 MiB以上）と、低速回線に適したタイムアウトを設定します。Mireaのアセット合計上限は既定2 GiBで、分割1要求の上限とは別です。HTTPSと内部HTTPで無限リダイレクトさせないでください。

Cloudflareを使う場合は[配信経路・利用条件の注意](cloudflare.md)も確認します。分割転送はCDNの動画利用条件を回避する手段ではありません。今回のWinVAI01のLAN限定公開は変更しません。

## 5. 導入後の確認

- 起動ログに`Mirea container sandbox enforced`があり、HTTPS事前検査を有効にした場合は`truenas_preflight_passed`もあること。
- Appsのコンテナがhealthyになり、`/api/health`の`status:ok`と、`version`が更新対象のリリースに一致すること（例`0.15.3-beta`）。
- 信頼されたHTTPSからログイン、本棚・シリーズ階層・サムネイルを確認。
- 小さなPDF／動画／音声をテスト専用本棚へアップロードし、ジョブ完了、再生・読書・シーク・保存・再接続を確認。
- アプリを停止・再開してもアカウント・続き位置・ダウンロード鍵が変わらないこと。
- 管理者でないアカウントに管理メニューが出ず、他人の本棚・個人詳細ログを取得できないこと。

CIはLinuxコンテナの変換・再作成・データ／鍵保持を検査しますが、実機TrueNASのUI・権限・プロキシまでは検証しません。

## 6. バックアップ・更新・復帰

### TrueNASの「更新」ボタンを使う場合（任意のstable／beta追従）

既定の版番号タグとdigest固定は、意図せず別の版へ変わらない構成です。TrueNASが新しい版番号のタグを自動で選ぶことはありません。標準の更新検出を使う場合に限り、imageを `ghcr.io/suiren-kazutohashimoto/mirea:beta` または初回正式版公開後の `:stable` へ変更できます。それぞれ公開済み・正式CI成功済みの最新ベータ版／正式版を指す可変タグで、版番号タグやdigestは引き続き固定のまま配布します。正式版がない間はstableを作りません。ドラフト、未成功のビルド、古い版の再公開では追従タグを動かさず、正式版とベータ版も混ぜません。詳細は[チャネル運用](container-channels.md)を参照してください。

TrueNAS側のイメージ更新検査後に「更新あり」が表示され、利用者が更新ボタンを押すと再取得・再作成します。MireaからNASのDockerやAPIを操作する機能、勝手に再起動する更新エージェントは追加しません。検出にはTrueNAS側の検査間隔があります。

Custom Appの更新ではHost Pathの自動スナップショットを期待しないでください。毎回、下記の停止中バックアップを先に取得します。独自の起動スクリプトで版・digestを固定している既存構成は、imageだけ変えても起動できません。初回の移行時はそのチェックもレビューし、TLS・実行ID・マウント・所有権・既存データ保護を残したうえで、追従タグへの明示的な移行を行います。安全チェックを削除して起動させないでください。

### Application Infoの表示上の制限（25.04.2.6）

Custom Appでは、App Versionがcustom、バージョンが1.0.0、SourceがN/A、アイコンが汎用表示になる場合があります。これらはNAS側のCustom App定義に由来し、Mirea本体の版を示しません。本体の版はMireaの設定画面や /api/health、実行中コンテナのイメージタグ・digestで確認します。

25.04の標準Custom App更新APIには、この表示用メタデータを編集する項目がありません。Docker/OCIラベルだけでApplication Info全体が更新されるとは保証しません。NASの .ix-apps 内のmetadata.yamlや集約ファイルを直接書き換える処理、管理ファイルを触る常駐スクリプトは提供しません。UI破損・更新時の上書きを避け、TrueNAS標準機能を優先します。

根拠: [25.04.2.6更新APIの入力定義](https://github.com/truenas/middleware/blob/TS-25.04.2.6/src/middlewared/middlewared/api/v25_04_0/app.py)、[Custom App更新処理](https://github.com/truenas/middleware/blob/TS-25.04.2.6/src/middlewared/middlewared/plugins/apps/upgrade.py)。

### 各更新時の手順

1. 実行中のアップロード／ジョブが終わったことを確認してMireaアプリを停止。
2. **DATA_DIR・MEDIA_DIRの両方の全体＋Custom App YAML・環境変数＋プロキシ設定／証明書を保護された場所へバックアップ**。停止状態のZFSスナップショットと別媒体への複製を推奨します。管理画面のメタデータのみのバックアップはメディアを含みません。
3. 新版のリリースノート・SHA-256・digestを確認し、同じHost Pathのままimageの版/digestだけを変更して起動。
4. 上記の導入後確認を実施。Mireaの管理画面からDocker更新は実行しません。Dockerソケット・NAS管理資格情報・特権をWebへ与えないでください。
5. 不調時は停止して、**旧イメージ＋更新前データ／設定の対応した組**を復元。新DBに旧サーバーを当てるダウングレードや、旧新サーバーから同じデータを同時に開く運用はしません。

0.15.1betaはDB v17、0.15.3betaはDB v18です。移行に備えて上記を毎回行います。App削除時もデータセットを削除しないでください。`docker compose down -v`は禁止です。

WinVAI01から移行する場合も最初に旧サービスを停止して全データをコピーします。同じHTTPSオリジンを維持できない場合、ブラウザー／アプリの端末内保存はサーバー別管理のため再接続・再取得が必要になる場合があります。移行検証が済むまで旧データを保持します。

SQLiteのローカル保存の根拠: [WALの制約](https://sqlite.org/wal.html)。GHCRのアクセス設定: [Container Registry公式仕様](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
