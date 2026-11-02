# Mirea — Orbit Media / めぐるメディア

2026-10-21に所有者が候補04を正式採用。元案は ../../brand-concepts/2026-10-21/04-orbit-media.png。

## 実装素材

- web/public/brand/orbit-mark.svg：紫＋ラベンダーの透過マーク。
- web/public/brand/orbit-mark-inverse.svg：暗色背景用の白＋淡い紫。
- web/public/brand/orbit-icon.svg：紫の角丸タイル＋白/淡い紫マーク。faviconにも使用。
- web/src/brand.js / brand.css：Mireaの文字を可読なテキストとして組み合わせ、テーマ・狭い画面に対応。
- Android res/drawable/mirea_launcher*.xml：同一パスのadaptive icon、Android13以降のmonochrome、起動画面。
- Android res/drawable/mirea_icon.xml：背景のない単色の通知用マーク。

元案から2本のループ・斜めの交差・紫の背面バンドをベクターに整理。同じパスをWebとAndroidで共有し、フォントはアプリのsans-serifに合わせて可読性を保つ。Android adaptive foregroundは108dpの中の約65dp幅に収め、丸型・各種マスクでの欠けを避ける。

色：violet #4026DF、lavender #A28AFF、暗色背景用lavender #B9A2FF、white #FFFFFF。マークの縦横比は360:210。

## 画像生成の利用

候補04は内蔵image_genで生成。採用時も同ツールで背景抽出を試行したが、透過PNGに輪郭や穴のノイズがあり、製品用素材には採用していない。既存のSVG/Android VectorDrawable資産の置き換えとして、選択案の形をコードネイティブのベクターに整理した。元の候補画像は変更していない。

生成プロンプトは候補フォルダーREADME.mdの04に記録。採用時の抽出プロンプトと不採用の理由は extraction-prompts.md に記録した。配布物に画像生成の中間成果物は含めない。
