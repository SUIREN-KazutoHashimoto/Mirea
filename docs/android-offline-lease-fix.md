# Androidのオフライン視聴期限更新エラー（0.6.2beta）

## 原因

WebViewで暗号化ダウンロードが完了しても、動画・音声のネイティブ再生へ取り込む前の追加認可で失敗していた。`MireaPlaybackPlugin.leaseSave` / `OfflineLease.authorize` は `PlaybackApi.json(...,"POST",null)` を呼び出すが、本文がnullの場合にContent-Typeと本文を指定していなかった。

[Android 35のHttpURLConnection実装](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-constraintlayout-release/android-35/com/android/okhttp/internal/huc/HttpURLConnectionImpl.java#375) はPOSTへ既定の `application/x-www-form-urlencoded` を付ける。MireaのAPIはJSONのみ受け付けるため415となる。サーバーの認証を緩めたりフォームの受付を追加したりせず、Androidの送信側で修正する。

## 修正

- null本文のPOSTでも `{}` をUTF-8のJSON、正しいContent-Lengthで送る。
- GETは本文なしのまま。既存の明示JSONの内容・UTF-8バイト列は変更しない。
- HTTPS必須、リダイレクト禁止、認証トークン・取得先制約は変更しない。
- 7日を超えて期限を延長する処理、TLS検証の回避、端末の鍵や暗号化データの作り直しは行わない。

## 検証

Nodeの実APIを使って既定の空フォームPOSTが415、明示JSONが200となることを再現。同じダウンロードID・鍵のままで既存の暗号化チャンクを復号し、他人には404となることも確認する。

Androidの回帰テストはループバックのテスト用HTTP接続だけにOS既定のフォームヘッダーを再現し、本番と共通のJSON送信処理を通す。修正前は415で失敗、修正後は期限を暗号化保存して再起動後に既存チャンクを読み出せることを検証。テスト用のHTTP接続は内部送信処理へ直接渡し、本番のHTTPS必須設定は変更しない。

実機未接続の場合、Android端末固有のKeystoreや証明書信頼の実動作までは検証できない。症状が残る場合にもアンインストールやダウンロード削除はせず、端末の情報を確認する。
