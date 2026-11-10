# HTTPSでPCとスマートフォンを接続する

Androidアプリと端末への暗号化保存を使うには、利用する端末が信頼できるHTTPS URLを用意します。サーバーのIPアドレスへHTTPで接続するだけでは十分ではありません。

対象: Mirea `2.0.0beta`。以下の名前と保存先は架空の設定例です。

## 1. 名前と接続経路を決める

最初はLAN内で使えるURLを一つ用意します。途中でURLを変更すると、ブラウザーの保存データやログイン情報が別のサイトとして扱われることがあります。

| 項目 | 例 | 用意するもの |
| --- | --- | --- |
| LAN内の名前 | `mirea.home.arpa` | LANのDNSでサーバー／プロキシのアドレスへ名前解決 |
| 所有ドメインの名前 | `mirea.example.com` | 自分のドメイン、用途に合うDNS設定と証明書 |
| URL | `https://mirea.home.arpa` | DNS名と一致する証明書、TCP 443への接続 |

`example.com` は説明用です。そのまま自分のサーバーへ向けることはできません。LAN名を使う場合も、全端末が同じ名前を解決できるDNS設定をネットワーク管理者に依頼します。証明書だけ作成してもDNSは設定されません。

基本構成は次のとおりです。

```text
ブラウザー／Android
    │ HTTPS 443
    ▼
HTTPSリバースプロキシ
    │ 同じホストの 127.0.0.1:3000
    ▼
Mirea
```

同じホストであればMireaの公開ポートを `127.0.0.1` に保てます。プロキシが別コンテナなら、その中の `127.0.0.1` はプロキシ自身です。同じ私設Dockerネットワークのサービス名を使うか、Mireaの特定LANアドレスへ限定して接続します。

## 2. 証明書を用意する

| 方法 | 端末側で行うこと |
| --- | --- |
| 公開CAの証明書 | 通常は追加CA登録不要。自分のドメインに対する証明書発行条件を満たす |
| 自分で管理するCAの証明書 | CAの公開証明書と指紋を確認し、使うPC・Androidへ明示的に信頼登録 |

CAの**公開証明書**とCAの**秘密鍵**は別物です。端末へ配布するのは公開証明書だけです。CA秘密鍵は証明書発行者が保管し、Mireaやコンテナへ置きません。

サーバー証明書にはURLと同じDNS名のSANが必要です。IP直打ちも使うなら、そのIPのSANも必要です。証明書の有効期限と自動／手動更新の担当も決めます。

## 3. 同じホストのCaddyを使う例

次は、既にOSにCaddyを導入した場合の `Caddyfile` です。Caddyの導入とサービス起動は[公式手順](https://caddyserver.com/docs/install)に従います。Mirea自体をrootや管理者で起動する必要はありません。

LAN用のCAをCaddyで管理する例:

```caddyfile
mirea.home.arpa {
    tls internal
    reverse_proxy 127.0.0.1:3000
}
```

既に取得した証明書を使う場合は、`tls internal`を次に置き換えます。パスはプロキシが読める場所に合わせます。

```caddyfile
tls /etc/caddy/tls/server-chain.pem /etc/caddy/tls/server-key.pem
```

設定を保存して検査します。

```sh
caddy validate --config ./Caddyfile --adapter caddyfile
```

成功したら、そのOSのCaddyサービスへ設定を反映します。`tls internal`を使った場合、Caddyのデータ領域にあるCA公開証明書を各利用端末へ配布します。サーバーで信頼されたことだけでは別端末は信頼しません。[CaddyのローカルHTTPS](https://caddyserver.com/docs/automatic-https#local-https)

ルーターのWAN側ポート開放は、LAN利用には不要です。初期設定が済む前に外部公開しません。

## 4. 端末から確認する

1. PCとAndroidを利用するLANに接続します。
2. ブラウザーで決めたHTTPS URLを開きます。証明書警告が出たら進まず、名前・SAN・期限・CA信頼を修正します。
3. `https://自分の名前/api/health` を開き、`status` が `ok`、`version` が対象版であることを確認します。
4. Mireaへログインし、小さな作品を開きます。
5. Androidアプリの接続先に同じHTTPS URLを入力します。ポートを変更した場合は `https://名前:ポート` とします。
6. 作品を暗号化ダウンロードし、保存完了後に通信を切って開けることを確認します。

AndroidではシステムCAと利用者が明示的に信頼登録したユーザーCAを利用します。登録の画面名はOS／機種で異なります。CA証明書の指紋は、ファイルを受け取った経路とは別の信頼できる経路で確認してください。証明書検証を無効にした接続は使いません。

## プロキシが保持する必要のあるもの

- `Authorization`、`Range`、`Content-Range`、`Content-Length`、`X-Chunk-SHA256`。
- 分割アップロードのPUT。既定8 MiBの1要求を受けられるサイズ上限。
- `/api/*` の認証付き応答を共有キャッシュへ保存しない設定。
- メディア応答を途中で圧縮・変換せず、Rangeのバイト位置を維持する設定。
- 再生チケット等を含むクエリ文字列を公開アクセスログへ残さない設定。

Mireaの動画はHLSとRange配信を利用します。WebとAPIを別ドメインへ分割する構成、前段の独自ログイン画面、対話式のアクセスゲートは追加の互換確認が必要です。Android用の `CORS_ORIGINS=https://localhost` を `*` へ変更しません。

## Mirea自身でHTTPSを終端する場合

Node.js直接起動では `.env` に両方を指定します。

```dotenv
HOST=サーバーのLANアドレス
PORT=3443
HTTPS_KEY_FILE=/srv/mirea/tls/server-key.pem
HTTPS_CERT_FILE=/srv/mirea/tls/server-chain.pem
```

`HOST`の値は実際のアドレスへ置き換えます。Windowsのパスは `C:/Mirea/tls/server-key.pem` のように書けます。片方不足・読取失敗・不正なTLS設定では起動せず、HTTPへ戻りません。

コンテナで直接HTTPSを行う場合は、証明書を必要最小限の読取専用マウントで渡し、同じ2変数を設定します。ヘルスチェック用に `HEALTHCHECK_CA_FILE` と `HEALTHCHECK_TLS_SERVER_NAME` も設定し、CA・名前を検証できるようにします。TrueNAS用の旧固定パス事前検査を使う既存構成は[互換条件](../container-security.md#truenas-https事前検査)を維持してください。

困ったとき: [接続・証明書の切り分け](../operations/troubleshooting.md)
