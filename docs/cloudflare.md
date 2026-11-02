# Cloudflareを使う場合の接続設計

対象: Mirea `1.0.0`。Cloudflare側の設定は2026-11-02に公式資料を確認しました。契約・制限は導入時にも確認してください。

Mireaのサーバーを用意した後に読む任意の構成例です。Cloudflareを使うことは必須ではなく、通常のLAN利用は[HTTPSの手順](install/https.md)で構成できます。

## 1. メディアの配信経路を決める

Cloudflare Tunnelの公開ホスト名はCloudflareのProxyを通ります。Free / Pro / Businessでは動画や大容量配信に利用条件があります。キャッシュ無効化や小さなリクエストへの分割だけで条件を回避できるわけではありません。私設ネットワーク経路は公開ホスト名とは扱いが異なります。[公式の動画配信方針](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)

候補は次のように分けます。

| 構成 | Mireaとの関係 |
| --- | --- |
| Cloudflareを経由しないHTTPS | 同一オリジンのWeb/APIとして利用可能。到達性とTLS入口は自分で管理 |
| 私設ネットワーク経由 | 利用端末に必要なネットワーク設定を行い、MireaのHTTPSへ接続 |
| 公開Tunnel／Proxy | メディア用途が契約に適合するかを事前確認 |
| Cloudflare Streamなど | 別サービス。Mireaに保存・配信の自動連携はない |

Mireaは動画のHLSとRange配信に対応しますが、この対応自体がCloudflareの配信条件を満たす保証にはなりません。動画だけを別ホストへ分ける設定も、単にDNSを追加すれば動くものではありません。

## 2. 接続先を決める

Mireaと`cloudflared`を同じホストで動かし、Mireaがループバックだけで待ち受ける場合は`http://127.0.0.1:3000`へ接続できます。これは同一ホスト内の区間です。別のPCをまたぐなら、信頼されたHTTPSのオリジンを使用します。

別コンテナ内の`127.0.0.1`はMireaではありません。同じ私設Dockerネットワークのサービス名、または明示的に限定したホストの接続先を使います。

ローカル管理Tunnelの構造例:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /etc/cloudflared/YOUR-TUNNEL-UUID.json
ingress:
  - hostname: mirea.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

`example.com`とUUIDは説明用です。Tunnelの作成と実行は[Cloudflare公式手順](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)に従います。資格情報ファイルやトークンをリポジトリへ保存しません。

## 3. 私設CAを使うHTTPSオリジン

オリジンが私設CAの証明書を使う場合、`cloudflared`がそのCAを信頼し、証明書の名前を検証できるようにします。

```yaml
ingress:
  - hostname: mirea.example.com
    service: https://origin.internal.example.com:3443
    originRequest:
      originServerName: origin.internal.example.com
      caPool: /etc/cloudflared/certs/origin-ca.pem
  - service: http_status:404
```

`caPool`は**cloudflaredから読めるCA公開証明書ファイルのパス**です。管理画面へPEM本文やCA秘密鍵を貼る欄ではありません。`cloudflared`がコンテナなら、そのコンテナ内へ公開CAを読み取り専用で配置します。`originServerName`にはオリジン証明書のSANに一致するDNS名を指定します。[公式TLSパラメーター](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)

証明書検証を無効にする設定を解決策にしません。エラー時はCAチェーン、SAN、期限、ファイルの実在と読み取り権限を確認します。

## 4. MireaのAPIをそのまま通す

- WebとAPIを同じHTTPSオリジンから配信します。
- `/api/*`を共有キャッシュへ保存しません。認証付きメディアにCache Everythingを適用しません。
- `Authorization`、`Range`、`Content-Range`、`Content-Length`、`X-Chunk-SHA256`とPUTを通します。
- Rangeのバイト位置を変える圧縮・変換を途中へ追加しません。
- アクセスログにはメディアチケットを含むクエリ文字列を残しません。
- Androidの同梱画面用Originは`https://localhost`です。CORSを`*`へ変更しません。

標準アップロードは独立したPUTへ分割し、取り込み・変換は受付応答後に処理します。作品全体の上限と1リクエストの上限は別です。リクエスト制限・タイムアウトは契約や設定で変わるため、[413の説明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)と[524の説明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)を確認します。

Mirea側の分割サイズは標準8 MiB、設定範囲は64 KiB〜16 MiBです。低速回線で失敗する場合は入口の制限を確認し、必要なら[管理設定](operations/settings.md)を調整します。既に開始した転送の分割サイズは途中で変更しません。

Cloudflare Accessの対話ログインを追加する場合は、Androidアプリとの認証連携を別途確認します。MireaのログインだけでAccessにもログイン済みになるわけではありません。

## 5. 接続確認と問題の切り分け

1. Tunnelを通さず、信頼済みのオリジンへ接続してMireaが起動していることを確認します。
2. 公開または私設経路からログインと小さな検証用作品の送信を試します。
3. 送信の再開、動画のシーク、書籍のページ移動、Androidの接続を確認します。
4. 一般アカウントで未共有本棚へアクセスできないことを確認します。
5. 問題が入口だけで起きる場合、HTTP状態コードと該当時刻でCloudflareの制限を調べます。

利用者の作品で試す必要はありません。接続できることと、契約・負荷・長時間再生の条件を満たすことは別々に確認してください。失敗時は既存の利用可能な経路を維持し、TLSや認証の保護を外さず原因を切り分けます。
