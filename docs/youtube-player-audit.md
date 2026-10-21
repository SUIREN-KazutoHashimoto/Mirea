# YouTubeとの動画プレイヤー差分（2026-10-21）

対象はMirea 0.4.4betaのWeb／ネイティブAPKの操作仕様です。YouTube公式ヘルプとソースを照合しました。YouTubeの実端末・Premium契約・段階的テストを網羅した実機比較ではありません。今回変更したのは再生頻度グラフの表示条件だけで、以下の不足機能を追加したわけではありません。

## 主な確認済み差分

| 項目 | YouTubeの公式案内 | Mireaの現状・根拠 |
| --- | --- | --- |
| 左右ダブルタップ（Android） | 左右のダブルタップで10秒戻し／送り。[速度・移動](https://support.google.com/youtube/answer/7509567?co=GENIE.Platform%3DAndroid&hl=ja) | APKは10秒戻し／送りボタンのみ。映像タップは操作パネル切替、ダブルタップ検知なし。PlaybackScreen.onTouchEvent／PlaybackActivity.act。Webの映像クリックは再生／停止で、モバイル専用の左右ダブルタップもない。 |
| サムネイル列を使う精密シーク | 再生ポイントを上へスライドしてサムネイル列から選択・取消。[精密シーク](https://support.google.com/youtube/answer/12825599?co=GENIE.Platform%3DAndroid&hl=ja) | Web／APKとも時刻表示と通常シークバーのみ。シーク用サムネイル列・場面画像・精密シークモードなし。一覧の画像／短時間動画プレビューは別の機能。video-player.js／PlaybackScreen.seek。 |
| 動画内チャプター | バーの区切り、章タイトル、章選択に対応。[チャプター](https://support.google.com/youtube/answer/12825599?co=GENIE.Platform%3DAndroid&hl=ja) | Web／APKとも動画内の章データ・表示・ジャンプなし。シリーズ（作品間の連続再生）は動画内チャプターとは異なる。 |
| ピンチズーム（Android） | アプリの全画面動画を2本指で拡大／縮小。[ピンチズーム](https://support.google.com/youtube/answer/12820428?hl=ja) | APKは縦横比を保った画面フィットのみ。2本指の拡大・ズーム位置移動なし。PlaybackPresentation.fit／PlaybackActivity.fitVideo。 |
| 自動画質（特にAPK） | 環境に応じた自動調節、手動解像度、高画質／データセーバー等。[画質](https://support.google.com/youtube/answer/91449?co=GENIE.Platform%3DAndroid&hl=ja) | WebのHLSは自動ABR＋解像度固定あり。ただし高画質優先／データセーバー、Wi-Fi／モバイル別の設定はない。**APKはHLS ABRではなくMP4 Range再生で、標準／固定画質のみ**。「標準」は自動切替ではない。PlaybackQuality／PlaybackService.open／PlaybackActivity.qualities。 |
| キーボード（Web） | J/Lで10秒、数字で割合移動、<>で速度変更、停止中の,/.でコマ送り等。[ショートカット](https://support.google.com/youtube/answer/7631406?hl=ja) | Space/K・M・F・プレイヤー領域の矢印操作は実装済み。J/L・数字・<>・コマ送り・Shift+N/P・I等は未実装。シークバー選択中はINPUTを既存キー処理から除外するため、矢印がYouTubeの5秒ではなくrangeのstep=0.01秒になる。video-player.js.keydown。 |
| 字幕 | 字幕のある動画でオン／オフ、言語・表示設定。[字幕](https://support.google.com/youtube/answer/100078?hl=ja) | 配信用の別字幕トラック、字幕選択／言語メニューなし。動画に焼き込まれた字幕はそのまま映るが、切り替え可能な字幕とは異なる。Webのvideo要素／ネイティブの再生メニュー。 |
| ダブルクリック（Web） | 全画面終了に動画ダブルクリックを利用可能。[全画面](https://support.google.com/youtube/answer/72689?co=GENIE.Platform%3DDesktop&hl=ja) | Webは全画面ボタン／Fキーを利用。dblclickハンドラーなし。連続クリックは再生／停止として処理される。video-player.js。 |

優先度の判断材料として、操作の慣れに直接関わるのは左右ダブルタップ・シークプレビュー・主要キー、自動で画質が変わるという期待との違いが大きいのはAPKのABR未対応です。追加実装は所有者の選択を待ちます。

## 今回の修正と、意図的に異なる仕様

- 再生頻度グラフは、Web／APKともシーク操作中だけ表示し、終了／取消／画面離脱で隠します。通常の再生や操作パネル表示だけでは出しません。YouTubeの[公式説明](https://support.google.com/youtube/answer/12825599?co=GENIE.Platform%3DAndroid&hl=ja)も、再生位置を移動させるとグラフが表示されると案内しています。YouTubeの各PC実験環境のhover条件まで同一だと保証するものではありません。
- Mireaの匿名集計（各区間5人以上・当日除外）と、成立しない場合の「自分の再生傾向」は所有者承認の仕様です。YouTubeと同じ集計アルゴリズムだとは主張しません。保存・権限・本人限定の分離は維持します。
- 全画面を基本に開くこと、シリーズ内の連続再生は既存の依頼仕様です。YouTubeに合わせるために解除しません。
- 長押し中2倍速、PiP、背景再生、画質固定、続き位置は既存機能として維持。OS／ブラウザーの制約やAPKの固定MP4実装までYouTubeと同じという意味ではありません。
- Mireaの速度選択はWeb6択（0.5/0.75/1/1.25/1.5/2）、APK5択（0.75なし）と両クライアント内でも差があります。YouTubeの契約・デバイス・地域で変わる速度上限や実験機能は、この比較で一律の必須仕様とはしていません。

## 検証の限界

グラフの開始・終了・キャンセルはNodeとAndroid Viewテストで検証します。Android実機での物理ジェスチャー／TalkBackは未検証です。APKのキー／支援技術からのシークはタッチの開始・終了コールバックに依存する実装で、別途確認が必要です。広告・コメント・投げ銭・YouTube独自コンテンツ解析・TV／iOS／ライブ／Shorts・Premium専用機能の全件比較は対象外です。
