# フォークして改修または独自配布する

フォークには、公式への変更提案、自分のサーバー用の改修、独立したAPK・コンテナの配布という使い方があります。目的に応じて識別子と署名の変更範囲を決めます。

## 目的を選ぶ

| 目的 | 必要なこと |
| --- | --- |
| 公式へ修正を提案 | 自分のforkでブランチを作り、`develop`向けPR。識別子を無関係に変えない |
| サーバーだけを自分用に改修 | 独立したデータで検証。公式版との差と更新方法を管理 |
| 独自のAndroidアプリも配布 | アプリID、表示名、APK署名、更新情報署名、公開鍵pin、配信元を一組で設計 |
| 独自のコンテナも配布 | 自分のregistry、CI、版・commit・digestの一致検査、公開方針を設定 |

公式の秘密鍵はリポジトリにありません。フォークしても公式アプリを上書きできる署名は手に入りません。独自版を公式更新として配信しないでください。

## 1 ソースを用意する

GitHubでForkし、Codeボタンから自分のURLを取得します。`YOUR_ACCOUNT` は自分のGitHub名に置換します。

```sh
git clone https://github.com/YOUR_ACCOUNT/Mirea.git mirea-fork
cd mirea-fork
git remote add upstream https://github.com/SUIREN-KazutoHashimoto/Mirea.git
git fetch upstream develop
git switch -c work/my-change upstream/develop
```

既定ブランチしかコピーしていなくても、fetchで公式 `develop` を基点にできます。既にremoteやbranchがある場合は `git remote -v`、`git branch` で確認します。[GitHubのfork説明](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/fork-a-repo)も参照してください。

[開発環境](setup.md)に従い、検証専用DBとHTTPS接続先を作ります。

## 2 自動更新の接続先を整理する

サーバーだけの試作では `APP_UPDATES_SOURCE=disabled` で公式APKの更新JSON自動取得を止められます。管理画面のサーバー更新チェックまで一括で切る設定ではありません。

独自配布では、次の信頼先を整合させる変更が必要です。単純な全置換ではなく、役割を確認して変更します。

| 対象 | 入口 | 変更後の確認 |
| --- | --- | --- |
| アプリID・namespace | [capacitor.config.json](../../capacitor.config.json)、[app/build.gradle](../../android/app/build.gradle) | Manifest、Java package、provider authority、import/R参照、生成物の一致 |
| 更新JSONのpackage名 | [update-manifest.js](../../server/update-manifest.js)、native `UpdateManifest` | 自分のAPKだけを受理し別packageを拒否 |
| APK更新元 | [remote-app-update.js](../../server/remote-app-update.js) | 自分のタグ・版・ファイル名への厳密一致 |
| サーバー更新元 | [server-updates.js](../../server/server-updates.js)、download/verify系スクリプト | 自分のrepoと許可した配布パスのみ取得 |
| コンテナ公開 | [publish-container.mjs](../../scripts/publish-container.mjs)、[container-channel-policy.mjs](../../scripts/container-channel-policy.mjs) | 自分のrepo/registry、CI、版、commit、digestの検証 |
| チャネルCI | [verify.yml](../../.github/workflows/verify.yml) | repo限定条件を自分のrepoへ明示変更。成功条件は維持 |
| イメージ案内 | Compose一式、Dockerfile labels、導入文書 | 公式と独自のイメージを取り違えない |
| ブランドとリンク | `web/src/about.js`、Web/nativeのアイコン・文字列 | 公式版と独自版を区別できる |

ホストを限定した旧Windows保守ヘルパーは汎用インストーラーではありません。ホスト確認を削除して流用せず、手動更新か、対象環境について別途レビューした最小権限の方式を使います。

## 3 二種類の署名鍵を用意する

独自配布では自分の **APK署名鍵** と **更新JSON署名鍵** を別々に用意します。

| 鍵 | 用途と保管 |
| --- | --- |
| APK署名鍵 | Androidが更新の同一性を判断。継続更新では同じ署名を維持 |
| 更新JSON署名鍵 | URL・版・サイズ・ハッシュ・署名者・期限を認証。実装はEC P-256 |
| TLS秘密鍵 | HTTPS通信。上記二つの代わりにはならない |
| メディア暗号鍵 | 端末保存の復号。配布署名変更時にも流用・再生成しない |

APK鍵はAndroid Studioの署名付きAPK生成から作成できます。[Androidの署名説明](https://developer.android.com/studio/publish/app-signing)を参照し、秘密鍵とパスワード設定をリポジトリ外に保管します。別媒体にも暗号化バックアップを取ります。

更新情報の**公開鍵だけ**を `server/update-signing-public.pem` と `android/app/src/main/assets/update-signing-public.pem` へ同じ内容で配置します。native側の追加pinやテスト期待値も確認します。署名検証を削除したり、任意の公開鍵をAPI応答から採用したりして通しません。

別アプリIDなら公式版と並行インストールできますが、別アプリの端末保存・Keystoreを引き継ぐ機能はありません。同じID・別署名は通常の上書き更新になりません。利用者のアンインストールを自動で実行しません。

## 4 独自版を検証する

1. 新規の検証用アカウントで本・音楽・動画、共有権限と端末保存を確認します。
2. 一つ前の独自APKから、同じ署名でversionCodeを上げた独自APKへ更新します。
3. 別署名、別package、不正URL、期限切れJSON、ハッシュ不一致、番号の巻き戻しを拒否します。
4. 更新元を変更した場合は、公式repoや任意URLが誤って許可されないことを確認します。
5. 検証した同じコンテナイメージを公開し、未検証の再ビルド品へ差し替えません。
6. 配布アーカイブにデータ・認証情報・署名鍵・実環境設定がないことを確認します。

[テスト](testing.md)と[リリース](release.md)の工程を通します。版番号を公式と同じにしただけで互換性が保証されるわけではありません。

## 5 上流の変更を取り込む

`git fetch upstream` 後、署名・配布先・DB移行・Capacitorパッチの差分を確認して取り込みます。データ変更を含む版では使い捨てのコピーで移行と復元を検証し、稼働DBに対してGit操作のついでに起動しません。

## ライセンスと案内

[LICENSE](../../LICENSE)と依存物のライセンス・配布条件を確認し、必要な本文・著作権表示を保持します。説明と更新先に独自配布であることを明記します。公式のテスト結果や署名を、自分のビルドの実績として転記しません。
