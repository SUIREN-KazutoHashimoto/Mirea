# Android配布物の安全性点検とPlay Protect

2026-11-02時点の調査記録です。ここで「補強」とする変更はMirea 1.0.0に含まれます。過去の公開済み0.25.0betaのAPKを差し替えるものではありません。[対象版と検証範囲](../status.md)を参照してください。

APK更新情報の定期再署名は、配布案内の有効期限を更新する処理です。APK本体やAPK署名を変えず、Googleの有害性判定を解除する処理ではありません。警告の詳細分類を取得できないため、原因の断定・誤検知の断定・修正後の判定解除の主張は行いません。

## Play Protect調査と安全性の補強（2026-11-02、1.0.0）

0.15系以降の公開APKについて有害アプリの警告が報告されたため、0.14〜0.25の公開成果物と現行コードを点検しました。Googleの非公開の分類理由や、修正後の実端末での判定結果は取得できていません。以下の検査成功はPlay Protectの判定解除を意味しません。署名を変える、難読化する、警告やTLS検証を無効にするといった対応は行っていません。

確認した事実:

- 0.14〜0.25の公開APK全23本を保存済みの実ファイルで検査し、GitHub公開SHA-256とサイズ、APK署名、同じ署名者、実際の版番号、ZIP内のCRCと構造が一致しました。0.15.1betaのリリースにはAPKが公開されていないため、その版のバイナリ検査はありません。
- 0.14.0betaと0.15.0betaは`classes.dex`と`classes2.dex`もバイト単位で同一です。両者の権限も同じで、警告の開始をAndroid権限追加や署名者変更で説明する根拠は得られませんでした。主な差分は同梱Web資産です。
- 依存指定の`^8.0.0`と実際の搭載版は異なり、当時のロックファイルも現在もCapacitor 8.5.3です。[内部HTTPプロキシの既知脆弱性](https://github.com/ionic-team/capacitor/security/advisories/GHSA-rvm3-566m-v7fv)の修正を含みます。修正済みの版へ明示固定し、経路の遮断を回帰テストへ追加しました。この脆弱性が未修正で搭載されていたという結論ではありません。
- Media3が要求するGuava 33.3.1-androidは、[デシリアライズ時の過大メモリ確保](https://github.com/google/guava/security/advisories/GHSA-xxph-c9ww-hj94)の修正前なので33.7.2-android以上を要求します。別件の[ハッシュ衝突による低速化](https://github.com/google/guava/security/advisories/GHSA-v5x9-67m3-7m56)は上流の修正版がありません。MireaのソースとMedia3 1.11.1の8個のAARのクラス定数では、対象のHashBiMap/LinkedHashMultimapとObjectInputStreamの利用は見つかりませんでした。後者を「修正済み」や「絶対に到達不能」とは扱いません。PDF.jsは修正版6.4.299を使用し、MireaはPDFスクリプト実行用のviewerを使用せず、描画でも`isEvalSupported: false`を指定します。
- 更新は署名付きJSONと現在のAPK署名者を検証し、Mirea自身だけを対象にします。通信先は利用者が選んだHTTPSサーバーと署名されたAPK取得先です。メディア転送のBearerを別originへリダイレクトする経路、TLS検証回避、広告SDKへの送信、SMS・連絡先・位置情報の取得、任意コマンド実行は調査対象コードから見つかりませんでした。

機能を維持して補強した範囲:

- FileProviderの共有範囲をカメラ一時画像の`Pictures/`へ限定。キャッシュ全体と外部ストレージ全体の共有設定を撤去しました。[AndroidのFileProvider指針](https://developer.android.com/privacy-and-security/risks/file-providers)
- WebView内のトップレベル画面を同梱originへ限定し、一般のWebリンクはブラウザーへ渡します。Mireaで未使用の内部HTTP・ファイル・contentプロキシは、画面遷移だけでなくスクリプトや画像などのリソース取得も拒否し、ServiceWorkerにも同じ制約を適用します。通常の画像・音声・動画・書籍は独自のHTTPS／blob／暗号化キャッシュ経路を使うため、その利用は維持します。
- 同梱画面にCSPを追加し、任意の外部スクリプトやinlineスクリプトを禁止。旧WebViewで必要な同梱Capacitor bootstrapだけは内容のSHA-256で許可します。
- APK起動パスには固定クエリーを付け、旧ServiceWorkerに残るCSPなしの画面キャッシュを起動直後から使用しません。同じ`https://localhost`オリジンのAPK同梱画面を直接開くため、オフライン起動も維持し、保存済みのメディア・鍵・履歴を消す必要はありません。ServiceWorker自身の取得にも同じネイティブ制約を適用します。
- Mireaで未使用のCapacitor Cookie/HTTPネイティブ連携を初期化前から停止する固定パッチを追加。CookieHandlerへの介入、不要なJavaScriptインターフェース、Cookie値をログへ出す経路を止めます。独自のBearer認証、転送、再生、生体認証は維持します。依存更新時は`patches/@capacitor__android@8.5.3.patch`と回帰テストを確認してください。
- 既存の`allowBackup=false`に加え、Android 12以降のクラウドバックアップと端末間移行を明示的に除外します。端末固有のKeystore鍵に結び付くセッションや保存データを、鍵のない別端末へ移さないための設定です。現在の端末内データやサーバー同期は変更しません。[Androidのバックアップ・端末間移行仕様](https://developer.android.com/identity/data/autobackup#EnablingAutoBackup)
- 接続先切り替え中の更新競合を防止し、インストール結果を秘密情報なしで区分表示します。自動更新自体は廃止していません。
- 選択ファイルへの永続読み取り権限を、選択画面と未完了の転送が必要とする間だけ保持します。新しく管理する権限はプロセス終了後も次の起動時に回収します。旧版の用途不明な権限はまとめて削除しません。転送後のサーバージョブ待ちだけでwake lockを保持する動作も修正しました。
- 配布前にはAPKの私有コピーを作り、ZIP構造、CRC、秘密鍵混入、署名、ハッシュ、版情報を同じコピーで検査します。公開先のコピーも再ハッシュし、検査中の並行ビルドによる取り違えを防ぎます。Gradle配布物の公式SHA-256も固定しました。

自動取得・自動適用は現行仕様として維持します。毎回の手動適用への変更でPlay Protectの判定が改善する根拠は得られておらず、署名・配布元・APK検証を保った自己更新を継続します。修正後も警告が続く場合は、公開APKのURL・ハッシュ・署名者と調査結果を添えてGoogleへ再審査を依頼できます。再審査は配布者が対象APKと申請内容を確認して行う別の手続きです。この調査では申請していません。


## 依存関係の点検（2026-11-02）

公開アドバイザリーとの照合では、更新前に中・低重要度11件（高・最高重要度0件）を検出しました。対象の`fast-uri`、`uuid`、`glob`、`minimatch`はサーバーまたはビルド用の依存関係で、APKのブラウザー実行コードには含まれません。この照合はPlay Protectによる有害判定の理由を調べる検査ではありません。

- `fast-uri`はFastify／Ajvのスキーマ参照解決に使われます。利用者の入力をスキーマとしてコンパイルしたり、同ライブラリーで接続先を許可判定したりする経路は確認していませんが、既存メジャー内の`3.1.8 → 3.1.9`、`4.2.2 → 4.2.3`へ更新しました。4種類のURI解釈・正規化問題（2系列で8件）に対応します。[3.1.9](https://github.com/fastify/fast-uri/releases/tag/v3.1.9)、[4.2.3](https://github.com/fastify/fast-uri/releases/tag/v4.2.3)
- 残る`uuid@7.0.3`はCapacitor CLI → Xcodeプロジェクト編集用です。実際の呼び出しは出力バッファーを指定しない`v4()`で、指摘対象の`v3/v5/v6`のバッファー書き込みは使っていません。修正版`11.1.1`へのメジャー越しの強制置換は保留しています。[上流アドバイザリー](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)
- 残る`glob@13.0.6`／`minimatch@10.2.6`は静的ファイル配信またはCLIのビルド作業用です。Mireaの静的配信は既定の`wildcard:true`で、`glob()`を使う`wildcard:false`の経路を通りません。利用者の検索文字列やアップロード名をglobパターンに渡す処理もありません。CLI側は決まったビルド用パスを使います。現状では、任意パターンの増幅やAbortSignalによる中止失敗という指摘部分に利用者入力から到達する経路を確認していません。修正版`glob@14.0.2`／`minimatch@11.0.1`への強制メジャー更新はせず、親依存の対応または互換性を検証した修正を別途行います。[glob](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4)、[minimatch](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)

更新後の再監査は中重要度3件、低・高・最高重要度0件でした。上記3件を監査から除外・非表示にはしていません。依存の呼び出し方や対応版が変わった場合は再評価します。更新後にセキュリティ・API・アカウントの既存テスト19件が成功しています。


## 検証結果の読み方

公開APK23本の検査は配布物の同一性を検証したものです。ソース点検、単体テスト、静的検査、APKビルドは、それぞれ異なる範囲を検証します。どれもGoogleの分類器や実端末上の全動作を再現する検査ではありません。

補強時にはAndroid単体テスト、WebView境界・バックアップ設定・更新情報の回帰検査、サーバーのセキュリティ/API検査とAPKビルドを実施しました。Android 17実端末でのPlay Protect再判定、メーカー別の省電力動作、外部への再審査申請は未実施です。今後の検証手順は[テストと実機確認](../development/testing.md)、公開の判定基準は[リリース手順](../development/release.md)に分けています。

## 実装の参照先

- [AndroidManifest](../../android/app/src/main/AndroidManifest.xml)：公開コンポーネント、バックアップ、権限。
- [Capacitor固定パッチ](../../patches/@capacitor__android@8.5.3.patch)：未使用の内部経路の遮断。更新時にはパッチ適用と境界検査を再実施します。
- [ネイティブ画面の境界テスト](../../tests/native-shell-boundary.test.js)、[APKアーカイブ検査](../../tests/android-archive.test.js)。
- [Android更新の利用と配信](../android-updates.md)、[Android設計](../design/android.md)、[セキュリティ設計](../design/security.md)。

判定に関する一次資料：[Google Play Protectの警告ガイド](https://developers.google.com/android/play-protect/warning-dev-guidance)、[開発者の再審査手順](https://support.google.com/googleplay/android-developer/answer/2992033)。
