# ストア外Androidアプリの更新（0.2.3beta）

## 利用者向け

専用署名版の初回インストール後は、アプリ起動時と約12時間ごとに接続先のMireaサーバーへ更新を確認します。自動確認・取得・適用は初期ON、取得はWi-Fiなど非従量制回線のみが初期ONです。Androidの省電力・ジョブ制御により時刻や実行は保証されません。強制停止後はアプリを再度開いてください。

「設定 → Androidアプリ」、またはログイン画面の「アプリの更新」から設定・手動確認・取得再開・適用を操作できます。ログイン前でも、HTTPSのサーバーURLを保存すれば利用できます。インストール済みの版はネイティブAPKから取得し、接続先サーバーの版とは区別します。

更新をインストールするには、利用者がAndroidの「この提供元のアプリを許可」をMireaに対して許可する必要があります。アプリは許可を勝手に変更しません。Android 12以降はOSの条件を満たす場合のみ無操作の自己更新を要求します。Android 10／11、初回更新、OSやメーカーの制約などでは「Androidの更新確認を開く」から最後の確認を行います。ストア外での完全なサイレント更新を全端末に保証する機能ではありません。[Androidの仕様](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int))

自動適用はアプリがバックグラウンドで、閲覧・動画再生・アップロード・端末ダウンロードを行っていない場合に限ります。フォアグラウンドでは取得・準備まで行い、適用は明示操作か後のバックグラウンドジョブに委ねます。取得中に閲覧・転送を開始すると一時停止し、次の実行でRange取得を再開します。同時処理は参照カウントで追跡するため、1件の終了で他の処理のロックは解除されません。

## 旧APKからの初回移行

既存0.2.0betaのCIデバッグ署名と新しい専用鍵は別です。そのまま上書きできる保証はなく、旧版にはこの更新機能自体がありません。初回は手動インストールが必要です。署名違いの際にアプリを自動アンインストールする処理はありません。[署名と更新の要件](https://developer.android.com/studio/publish/app-signing#considerations)

アンインストールすると端末内の暗号化ダウンロード・接続先設定・未送信の記録は失われます。移行前にオンラインで閲覧記録・続き位置を同期し、必要な作品は移行後に再ダウンロードしてください。サーバー上のアカウント・本棚・同期済みの記録は、アプリの入れ替えだけでは削除されません。[0.2.3betaの専用署名APK](https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/tag/v0.2.3beta)を初回導入に利用してください。

## 配信と検証

- 更新先は保存済みのMirea HTTPSオリジン。認証トークンは更新リクエストに付けません。公開GET／HEAD APIはアカウント情報を返しません。
- `GET /api/v1/app-updates/android/manifest` は署名付き更新情報、`GET /api/v1/app-updates/android/apk/<versionCode>` はAPK（Range対応）です。未設定・未配置は404、署名・期限・ハッシュ等の不正は503で閉じます。
- APK内に固定したECDSA P-256公開鍵で更新情報を検証し、APK全体のSHA-256・サイズ・packageName・versionCode・versionName・minSdk・APK署名証明書を検証してからPackageInstallerへ渡します。APK署名は現在インストール済みの署名と一致する必要があります。
- versionCodeの後退、同じ番号で異なるAPK、任意パッケージのインストール、HTTP、ユーザー情報付きURLを拒否します。APKは512 MiB以下。途中ファイルはアプリ専用noBackup領域に置き、共有ストレージや外部インストール用の任意パスは公開しません。
- 更新情報の有効期間は最大7日です。期限切れ時は、同一APK・番号・ハッシュのまま更新情報を再署名する必要があります。端末の日時が大きくずれていても検証に失敗します。
- HTTPSの証明書・ホスト名検証は無効化しません。LANのルートCAを利用する場合は端末側で明示的に信頼設定してください。
- OSが返す確認IntentはセッションID・ランダムnonceを照合した非公開Receiverで受け、システムの確認先だけを利用者の明示操作で開きます。確認画面をバックグラウンドから強制表示しません。

署名された不正な新バージョンまで防ぐ仕組みではありません。配布者の署名鍵とビルド環境を厳重に保護してください。鍵ローテーションはこの版の自動処理の対象外です。

## ビルド・発行者向け

JDK 21、Android SDK platform 36／build-tools 36.0.0が必要です。署名用PKCS12と設定はリポジトリの外に置きます。設定例（値は自分の保管庫で管理し、コミット・チャットへ貼り付けない）：

```properties
storeFile=C:/secure/Mirea-Signing/mirea-release.p12
storeType=PKCS12
storePassword=<secret>
keyAlias=mirea-release
keyPassword=<secret>
```

```sh
pnpm android:sync
cd android
./gradlew testDebugUnitTest lintDebug assembleRelease -PmireaSigningPropertiesFile=/secure/Mirea-Signing/signing.properties
```

Windowsでは`gradlew.bat`を使用します。未設定時の開発ビルドに配布鍵は使われません。CIはデバッグビルド・Java単体テスト・lintまでを行い、配布秘密鍵を必要としません。CIデバッグAPKを自動更新用に公開しないでください。

APK署名用PKCS12と、更新情報署名用の別のEC P-256秘密鍵を保管します。対応する公開鍵だけを`server/update-signing-public.pem`と`android/app/src/main/assets/update-signing-public.pem`に同じ内容で格納します。**秘密鍵、パスワード設定はGitHub、サーバーパッケージ、コンテナ、APP_UPDATES_DIRへ入れません。** 鍵・パスワードを暗号化した別媒体へバックアップしてください。ローカルのアクセス制限だけはオフホストのバックアップではありません。

```sh
node scripts/sign-android-update.mjs --apk=/build/app-release.apk --apk-url=https://mirea.example/api/v1/app-updates/android/apk/4 --private-key=/secure/Mirea-Signing/metadata-private.pem --output=/distribution/mirea-updates --sdk=/android-sdk --java=/jdk/bin/java
```

実APKをapksignerで検証し、aapt2から版・最小SDKを読み、デバッグ署名を拒否してから`manifest.json`と`mirea-android-4.apk`を生成します。公開鍵が対応しない秘密鍵を拒否します。versionCodeは更新のたびに単調増加させます。同一番号のAPKを差し替えず、有効期限の更新だけを同じコマンドで行います（最大168時間、`--validity-hours=`で短縮可）。署名用端末上の公開ファイル用ディレクトリへ生成した後、公開ファイルだけをサーバーへ転送し、APK→manifestの順で反映してください。GitHubへの公開・鍵のSecrets登録・自動転送はこのスクリプトでは行いません。

直接起動では`.env`の`APP_UPDATES_DIR`に公開ファイルだけのディレクトリを指定します。相対パスはインストール先基準です。未指定では更新APIは404です。Web／アセット閲覧は更新配信が未設定でも動作します。

コンテナでは公開バンドルを読み取り専用マウントします。

```sh
# .env: APP_UPDATES_HOST_DIR=/distribution/mirea-updates
docker compose -f compose.yaml -f compose.app-updates.yaml up -d --build
```

発行後はHTTPS経由のmanifest・APKハッシュ、同じ署名の旧版→新版の更新、閲覧中の保留、OS確認が必要な端末、ネットワーク中断後の再開を実機で確認してください。Java／サーバーの自動テストやAPKビルド成功だけで、全メーカーの実機更新が成功したとは判断しません。
