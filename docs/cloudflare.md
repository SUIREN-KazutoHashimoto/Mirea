# 自前サーバー（直接起動／コンテナ）＋Cloudflare Tunnel／Proxy

2026-10-19時点の公式資料を確認しています。サーバーはNode.jsの直接起動とコンテナ起動のどちらでも使えます。SQLite・メディアは直接起動ならホストの保存先、コンテナなら永続ボリュームまたはホストディレクトリに保存します。WorkersやCloudflare Containersへの移植ではありません。Cloudflare側への実デプロイ・実回線試験はまだ行っていません。

## 先に決めること：動画の配信経路

公開Tunnelのホスト名もCloudflareのProxyを通ります。Free / Pro / Businessで動画や大容量ファイルを通常のCDN経路から配信する場合、Cloudflareのサービス条件を満たす必要があります。キャッシュを無効化したり、ファイルを小さく分割したりしても、この条件の回避にはなりません。[Cloudflareの動画配信案内](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)

選択肢は次の通りです。

- Cloudflare Streamなど、用途に対応するサービスを使う。契約・費用と、サーバー側の保存／配信連携が別途必要です。現在は未接続です。
- Cloudflareを経由しないDNS-onlyのHTTPS経路で配信する。自前の到達可能なサーバー・証明書・入口の保護が必要です。現行版は同一オリジンなので、まずサービス全体をその経路で動かす構成になります。動画だけ別ドメインへ分離する機能は未実装です。
- 閉じた利用では、Cloudflare One Client（WARP）等で私設ネットワーク経路へ接続する。公開ホスト名のTunnelとは別です。公式案内では私設ネットワーク経路は上記制限の対象外とされています。利用者PC／Android側のネットワーク設定と、信頼できるHTTPS証明書が必要です。

本棚のアカウント認証はどの経路でも維持します。以下の公開Tunnel例だけを設定して、本サービスの動画配信が本番対応済みとは扱わないでください。

## 転送の実装

Cloudflareの1リクエストのアップロード上限はFree / Proで100 MBです。ゾーン設定でさらに低くされていることもあります。Mireaは標準8 MiBの独立したPUTへ分割します。HTTPのTransfer-Encoding: chunkedで大きな1リクエストを送る方式ではありません。[413の公式資料](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)

結合・形式検査・サムネイル生成は202応答の後で処理し、短いGETで状態確認します。Cloudflareの既定Proxy Read Timeoutは125秒で、公式資料も長い処理には状態確認方式を案内しています。[524の公式資料](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)

`.env` の例:

```dotenv
MAX_UPLOAD_BYTES=2147483648
UPLOAD_CHUNK_BYTES=8388608
CORS_ORIGINS=https://localhost
```

`UPLOAD_CHUNK_BYTES` の設定範囲は64 KiB〜16 MiB、合計上限は別の `MAX_UPLOAD_BYTES` です。低速回線で各PUTがタイムアウトする場合は `1048576`（1 MiB）へ下げます。すでに開始したアップロードの分割サイズは固定されるため、変更は新規開始分に適用されます。分割しても通信断やすべてのタイムアウトをなくせるわけではなく、失敗分を再送・再開できる設計です。

動画はHTTP Rangeのプログレッシブ配信です。PDF.jsは必要範囲のRange読み出しを使い、不要な自動先読みを止めています。HLS／DASH・自動画質変換は未実装です。PDFの構造によってはページ表示に全体が必要です。

## Web／API入口のTunnel設定例

`cloudflared` をMireaと同じホストで動かす場合、Composeの `127.0.0.1:3000` へ接続します。CloudflareアカウントでTunnelとホスト名を作成してから、公開ホスト名のサービスを `http://127.0.0.1:3000` に設定します。ドメインやTunnel IDは利用するものに置き換えてください。

ローカル管理Tunnelの設定ファイル例:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /etc/cloudflared/YOUR-TUNNEL-UUID.json
ingress:
  - hostname: mirea.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

`cloudflared` も別コンテナに入れる場合、そこでの127.0.0.1はMireaを指しません。同じDockerネットワークから `http://mirea:3000` へ接続する別構成が必要です。Tunnelの資格情報・トークンをGitへ保存しないでください。[設定ファイルの公式資料](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)

通常のProxyを使う場合も、WebとAPIを同じHTTPSホストから配信します。オリジン接続は有効な証明書を検証する構成にし、公開された3000番ポートへ直接接続させないでください。

## キャッシュ・ヘッダー・認証

- `/api/*` はキャッシュをバイパスします。Cache Everything等で認証付き応答を共有キャッシュへ保存しないでください。
- `Authorization`、`Range`、`Content-Range`、`Content-Length`、`X-Chunk-SHA256` とPUTを通します。
- メディアAPIは `Cache-Control: private, no-store, no-transform` を返します。途中の圧縮・変換でRangeのバイト位置を変更しないでください。[Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/)
- ログはクエリを除外し、動画チケットを記録しません。アプリは任意のX-Forwarded-Forを信用しないため、入口側でもログイン試行を制限してください。
- Android向けの信頼済みOriginは `https://localhost` です。Cloudflare Accessの対話ログインを前段へ追加する場合、現行Androidクライアントとの認証連携は別途必要です。Mireaの本棚認証だけでAccessが自動連携するわけではありません。

本番確認は、100 MBを超える検証用動画の分割送信、送信中の切断・再開、シーク時の206応答、PDFのRange取得、共有解除後の拒否、Androidからの接続で行ってください。ドメイン・配信経路・Cloudflareプランの選定後に、実環境で確認する必要があります。
