# Linuxコンテナの起動保護（0.15.1beta以降）

TrueNAS 25.04.2.6のguided Custom App（ix-app 1.4.7）は、`read_only`・`cap_drop`・`no-new-privileges`を指定できません。Mireaはこれらの**Docker設定を変更するのではなく**、非rootランチャーでアプリケーション自身を制限します。通常のComposeでは従来のDocker側保護も併用します。

## 必須条件と処理順

1. 通常のDocker seccompフィルターが有効。特権・seccomp無効化は不可。
2. UID/GIDとも非0。有効・許可・継承・ambient capabilityは空。
3. 余分な継承FDを閉じ、`PR_SET_NO_NEW_PRIVS`を設定。setuid／file capabilityによるexec時の権限昇格を禁止。
4. Landlock **ABI 3以上**を要求。通常Linux 6.2以降で、ホストの有効LSMにLandlockが必要です。未対応・無効・syscall拒否なら終了コード78で停止。自動的に制限を落とす設定はありません。
5. 単一スレッドのネイティブランチャーがLandlockを適用してからNodeへexec。以後のスレッド・PDFワーカー・FFmpeg等の子にも継承します。
6. TrueNAS専用検査を有効にした場合は証明書・所有者・初回状態を検査。その後で初めてDBを開きます。

イメージのEntrypointは`/usr/local/bin/mirea-launch`、Commandは`/usr/local/bin/node /app/server/container-entry.mjs`です。**GUIで上書きしないでください。** ランチャーを迂回するコマンドや`docker exec`はアプリの子ではなく、この制限を受けません。運用者のDocker管理権限をアプリから隔離するものではありません。

## 許可範囲

- 通常ファイルの作成・書込・切詰め・削除とディレクトリ作成・削除・領域間rename/linkを許可するのは、`/data`・`MEDIA_DIR=/media`指定時の`/media`・`/tmp`以下のみ。`/dev/null`への書込だけを例外として許可します。
- ネイティブ実行はroot所有の`/usr`と`/app`内のみ。`/tmp`・データ内の生成バイナリは直接実行できません。スクリプトをインタープリターに渡すことまで禁止するものではありません。
- symlink、FIFO、UNIXソケット、デバイスノードの新規作成は許可しません。既存symlink経由でも許可外の書込先へ脱出できません。
- 0.18.2beta以降、ランチャーが`SQLITE_TMPDIR=/tmp`をNode起動前に固定します。SQLiteのUnix側の候補は通常`/var/tmp`が`/tmp`より先ですが、モードの検査を通ってもLandlockによる実際の作成は拒否されることがあります。大量の削除・ソートで必要になる一時ファイルを、既存の許可済み`/tmp`へ置きます。GUIで変数や権限を追加する必要はありません。DB本体・WAL・鍵の保存先は変えず、書込権限も広げません。
- 読取・ネットワークはこのルールでは制限しません。マウントはMirea専用の必要最小限だけにしてください。Dockerソケット・ホスト全体・他アプリのデータを渡しません。
- Landlock ABI 3はchmod／chown／拡張属性等の全メタデータ操作を制限する仕組みではありません。実行コードをroot所有にし、実行ユーザーにcapabilityを持たせず、追加の書込可能マウントを与えない前提です。Dockerの読取専用root FSと完全に同一ではありません。
- GUIではDockerのcapability境界集合が既定のままでも、実効・許可等が空でno_new_privsが有効なら起動します。Dockerの`cap_drop: ALL`を適用したとは表示しません。

ホスト／Dockerの管理者、カーネルの脆弱性、悪意あるイメージ自体から利用者を隔離する機能ではありません。root起動・追加capability・seccomp無効化で起動エラーを回避しないでください。

## TrueNAS HTTPS事前検査

`MIREA_TRUENAS_PREFLIGHT=1`は、専用の新規HTTPS導入用です。次を環境変数で指定します。値は公開情報であり、**秘密鍵本体を環境変数へ入れません**。

| 変数 | 内容 |
| --- | --- |
| `DATA_DIR` / `MEDIA_DIR` | `/data` / `/media` |
| `MIREA_STORAGE_GROUP_ID` | 2つの保存先の実際のGID（実行GIDとは別でもよい） |
| `MIREA_INSTALL_ID` | このインストール専用の16～80文字の固定ID。再起動・更新でも維持 |
| `HTTPS_KEY_FILE` | `/data/keys/tls/server-key.pem` |
| `HTTPS_CERT_FILE` | `/data/keys/tls/server-chain.pem`（leaf＋root） |
| `HEALTHCHECK_CA_FILE` | `/data/keys/tls/suiren-root-ca.pem` |
| `HEALTHCHECK_TLS_SERVER_NAME` | leafのDNS名 |
| `MIREA_TLS_IP` | leafのIP SAN |
| `MIREA_TLS_ROOT_SHA256` | root証明書のDER SHA-256（64桁hex） |
| `MIREA_TLS_LEAF_SHA256` | leaf証明書のDER SHA-256 |
| `MIREA_TLS_SPKI_SHA256` | leaf公開鍵のSPKI DER SHA-256 |

保存先は実行UIDが所有し、指定した保存先GIDと一致し、other権限なし。`keys`と`keys/tls`は実行UID/GID・0700。秘密鍵は0600、2つの公開PEMは0644で実行UID/GID所有・通常ファイル・リンクなしが必要です。勝手なchown／chmodやACL拡大はしません。

rootの自己署名・leaf署名・CA制約・serverAuth専用EKU・DNS/IP・両証明書の期限・秘密鍵の一致と3つの指紋を検査します。これはオンラインの失効確認を保証するものではありません。HTTPS自体の信頼／ホスト名検証も無効化しません。

初回はdata内が`keys/tls`の3つのPEMだけ、mediaが空であることが条件です。すべての検査後に0600の`.truenas-mirea-bootstrap.json`を排他的に作成します。その後は同じ導入ID・証明書・実行IDの領収情報を確認し、データや鍵を維持して再起動できます。領収情報を消して既存DBを自動採用する機能はありません。旧インラインguardのschemaVersion 1との自動互換もありません。

証明書交換・ID変更・既存環境の導入では、停止・全バックアップ・新旧情報のレビューが必要です。エラー時に証明書以外を削除して無理に初期化しないでください。通常の版更新では導入ID・証明書を変えず、領収情報も保持します。

## 検証

CIはGUI相当の書込可能root・Docker既定capability境界集合で、拒否先への書込／切詰め／rename／hardlink・symlink脱出・子／ワーカーの継承・データ領域の正常動作を確認します。root・seccomp無効・Landlock syscallなしは停止することも検査します。通常Composeでの実メディア変換・データ／暗号鍵の再作成保持も別途確認します。TrueNAS実機はインストール時に同じ起動ログと厳密なHTTPSで確認します。

根拠: [Linux no_new_privs](https://docs.kernel.org/userspace-api/no_new_privs.html)、[Landlock](https://docs.kernel.org/userspace-api/landlock.html)、[ix-app 1.4.7テンプレート](https://github.com/truenas/apps/blob/master/trains/stable/ix-app/1.4.7/templates/docker-compose.yaml)。
