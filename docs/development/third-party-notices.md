# 第三者ライセンスの生成と同梱

Mireaの「Mireaについて」から「第三者ライセンスを見る」を開くと、利用しているライブラリーの版・ライセンス・原文を確認できます。本文はその画面を開いた時に読み込み、通常の起動や再生では展開しません。Web/PWAの保存対象にも含まれ、Androidは同梱ファイルを使用します。

## Webとサーバー

`pnpm build` は [生成スクリプト](../../scripts/third-party-notices.mjs) を実行し、実際にインストールされたproduction依存を再帰的に辿ります。devDependenciesや未インストールの他OS向けoptional依存は含めません。各パッケージのLICENSE・NOTICE・COPYING・COPYRIGHTをそのまま保持し、READMEに完全な許諾本文がある場合も保持します。FFmpeg/FFprobeの同梱READMEとネイティブ画像ライブラリーのSBOMも、配布元・構成・ソース参照を失わないよう収録します。

出力は `dist/third-party-notices.json`、`.txt`、`.html` です。一覧はサーバー依存とOS別依存を含む広い集合であり、全項目がブラウザーのJavaScriptへ組み込まれることを意味しません。JSONには名前・版・宣言されたライセンス・公開の上流URL・文書内容だけを入れ、インストール先の絶対パスや設定を含めません。HTMLは本文をエスケープします。

`pnpm dev` でも同じ生成器の内容を3つの固定URLへ配信します。過去のdistに依存せず、初回の閲覧時にメモリー上で生成します。依存を変更した場合は開発サーバーを再起動します。

原文が見つからない依存はビルドを失敗させます。npm配布物の同梱漏れに対しては、[補足資料](../../third-party/README.md)で取得元・対象版・原文と補足の違いを記録します。版をまたいで黙って同じ補足を使い回しません。

Linux x64向けlibvips 1.3.4は、実際のnpm配布物に独立したLICENSEが含まれていません。その版のライセンス宣言・上流リポジトリ・README・構成ライブラリーの版一覧を照合し、固定版SPDX資料にあるLGPLv3と組み込まれるGPLv3の原文を補足します。上流の構成表もそのまま保持し、ビルドスクリプトのApache-2.0をバイナリーのライセンスとして流用しません。対象版や文書ハッシュが変わった場合、補足が欠けた場合は生成を止めます。このLinux配布構造はOSに依存しない回帰テストでも検査します。

サーバーアーカイブはdistと補足資料を同梱します。導入時に取得するnode_modulesにも各依存の原文が残ります。コンテナは同じ生成済みdistと補足資料を含み、OSパッケージのcopyright情報は `/usr/share/doc` に残します。OSのFFmpeg等とnpmのダウンロード済みバイナリーは、同じ版・同じビルドとは限りません。SBOMやライセンス一覧の存在だけで、ネイティブバイナリーの全構成要素の配布条件を個別に確認したことにはなりません。

## Android

[Gradleタスク](../../android/third-party-notices.gradle) `generateThirdPartyNotices` は実際のreleaseRuntimeClasspathから外部ランタイム成果物を選び、POMのライセンス宣言、JAR/AARと内部classes.jarの原文を収集します。親POMからの継承も辿ります。Apache 2.0を宣言する成果物には標準本文を添えます。宣言や必要な本文を解決できなければビルドを止めます。

`preBuild`から自動実行し、生成した `public/third-party-native.json` をAPKのassetsへ追加します。Capacitorのプロジェクト依存の原文はnpmカタログに含まれます。Web側の本文も更新するため、APKを作る前に `pnpm android:sync` を実行してください。署名鍵をこの生成処理で読み取りません。

## 変更時の確認

1. 依存を更新したら `pnpm build` と `node --test tests/third-party-notices.test.js tests/package.test.js` を実行します。
2. Androidは同期後にGradleビルドし、生成されたカタログに実ランタイム依存が含まれることを確認します。
3. 配布アーカイブのdist、APK内の `assets/public/third-party-notices.json` と `assets/public/third-party-native.json` を確認します。
4. 「Mireaについて」から本文を開き、上流表示が欠けず読めることを確認します。合成環境の `scripts/check-workspace-ui.mjs` にこの操作を含めています。

生成器は配布内容を追跡し原文を保持するための仕組みです。ライセンスの解釈、ソース提供等の追加条件、独自のバイナリー再配布を自動的に判断するものではありません。フォークで新しい依存やネイティブビルドを加える場合も、必要な条件と同梱文書を確認してください。
