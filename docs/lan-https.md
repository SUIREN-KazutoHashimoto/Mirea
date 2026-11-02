# LAN内でHTTPSを使う

通常の導入手順は[HTTPSと証明書](install/https.md)へ移しました。LAN内でもAndroidアプリ、Service Worker、端末保存には信頼されたHTTPSを使います。証明書の警告を無視したりTLS検証を無効化したりしません。

## PowerShellでローカルCAを用意する場合

既に組織のCAや信頼済み証明書がある場合は、それを管理者の手順で発行します。新しくローカルCAを作る必要がある場合だけ、[New-LanCertificate.ps1](../scripts/New-LanCertificate.ps1)を使用できます。この補助手順は証明書の発行のみで、サーバーやDNS、信頼ストアを自動設定しません。

前提:

- PowerShell 7以上。WindowsではCAの保護ACLを設定するため管理者PowerShellを使います。
- サーバーのDNS名とLANのIPアドレスが決まっていること。
- CAを保管する領域と、サーバー証明書を出力する空の領域を分けること。
- MireaプロセスにCA秘密鍵の読み取り権限を付けないこと。

リポジトリのルートから実行します。質問には自分のパス・名前を入力します。パスに空白があっても引数として扱われます。

```powershell
$certificateAuthorityPath = Read-Host 'アプリ外のCA保管フォルダー'
$serverCertificatePath = Read-Host '空のサーバー証明書フォルダー'
$serverDnsName = Read-Host '端末から使うサーバーDNS名'
$serverLanIp = Read-Host 'サーバーのLAN IPアドレス'
./scripts/New-LanCertificate.ps1 -AuthorityDirectory $certificateAuthorityPath -OutputDirectory $serverCertificatePath -DnsName $serverDnsName -IpAddress $serverLanIp
```

成功すると期限・CAのSHA-256指紋・出力先が表示されます。次のファイルが生成されます。

| ファイル | 用途と取り扱い |
| --- | --- |
| `server-key.pem` | サーバー秘密鍵。サーバー実行者と管理者だけが読めるよう保護 |
| `server-chain.pem` | サーバー証明書とCAチェーン。HTTPSサーバーへ配置 |
| `lan-ca.cer` / `lan-ca.pem` | CA公開証明書。信頼する端末だけへ配布 |
| CA領域の `private/root-key.pem` | CA秘密鍵。サーバーや端末、Git、コンテナへ配布しない |

サーバー証明書は1年、作成するCAは5年の有効期限です。既存の完全なCA領域は再利用しますが、既存サーバー証明書を上書きしません。CAが不足・不整合・期限不足なら処理を止めます。エラー時は元の領域を消して再作成せず、入力先と期限を確認してください。

LinuxなどWindows以外では、保管先の権限を管理者が別途制限します。証明書を生成できたことと秘密鍵の適切な保護は別です。

## 信頼、更新、復旧

CA公開証明書の指紋を別の信頼できる経路で照合し、利用端末の証明書管理から明示的に信頼します。MireaのAndroidアプリはユーザー導入CAに対応しますが、ホスト名不一致・期限切れ・不正署名は引き続き拒否します。

更新では同じCA領域と、新しい空の出力先を指定して発行します。旧証明書を保存してからプロキシまたはMireaのTLSパスを切り替え、[HTTPSの確認手順](install/https.md)で検証します。既存の専用事前検査を使うコンテナは指紋も固定しているため、単純なファイル置換を行わず[契約を確認](container-security.md#truenas-https事前検査)してください。

CA秘密鍵はアクセス制限されたバックアップへ保管します。漏洩や廃止時には、利用端末から旧CAの信頼を除去します。秘密鍵の公開やTLS検証の回避を復旧策にしません。
