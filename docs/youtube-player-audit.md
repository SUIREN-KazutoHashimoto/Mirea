# YouTubeとの動画プレイヤー操作比較（0.5.0beta、2026-10-21）

0.4.4betaで報告した差分を追加・修正しました。YouTubeの全サービス、地域別／Premium限定／実験中の挙動まで同一にするものではありません。

| 操作 | Mirea 0.5.0beta |
| --- | --- |
| Android左右ダブルタップ | 左半分で10秒戻る、右半分で10秒進む。ボタン・シーク操作は対象外。Webタッチも同様。 |
| 精密シーク | 通常シーク中に場面画像。上へ約50pxスライドして場面列から選び、確定／取消。Webはメニューのボタンでも開始可能。 |
| 動画内チャプター | 配信元の章情報を抽出、手動編集も可能。シークバーの区切りと章選択。シリーズの作品間移動とは別。 |
| ピンチズーム | Web／APKは1～4倍。APKは拡大位置の移動／リセットも対応。 |
| APKの自動画質 | Media3 HLSによるABR。自動／高画質優先／480p以下のデータセーバー／解像度固定。保存データは選択済みの1画質。 |
| 回線別の画質 | APKはWi-Fi／モバイル別の初期設定。Webは判定不能なブラウザーで手動プロファイルを選択可能。 |
| Webキーボード | Space/K、J/L、矢印、0～9、Home/End、<>速度、停止中の,/.、Shift+N/P、I、C、F、M、Ctrl+左右の章移動。選択中のシークバーの矢印も5秒。 |
| 字幕 | 埋め込みのテキスト字幕、SRT／WebVTT追加。言語・オンオフ・文字サイズ。画像字幕や自動生成／翻訳は非対応。 |
| Webダブルクリック | 全画面の開始／終了。通常クリックの再生操作と区別。 |
| 速度 | Web／APKとも0.25～2倍の0.25刻み。長押し中だけ2倍、終了時に元の速度へ戻る。 |

## 意図的に異なる仕様・制約

- 全画面基本、暗号化ダウンロード、開くたびのオンライン権限確認、シリーズ連続再生は所有者の依頼仕様を維持します。
- 再生頻度グラフはシーク操作中のみ。各区間5人以上・当日除外の匿名集計が成立しなければ、本人だけの「自分の再生傾向」。YouTubeと同じ集計ではありません。
- シーク画像は最大120点の代表キーフレーム。長尺では間隔が広くなり、正確なそのフレームを保証しません。コマ送りは配信用30fpsを基準とした位置移動です。
- 高画質優先は最高の対応画質を優先するため帯域不足で待つ場合があります。自動画質を選ぶと帯域に追従します。動画に480p以下がなければ最小画質を使用。
- 別字幕は動画再生画面のオーバーレイ。OS／ブラウザーPiPへの字幕合成や背景再生時の字幕表示は保証しません。元動画へ焼き込みません。
- 元ファイルがすでに削除され、配信用動画に字幕／章が残っていない場合は復元できません。手動追加を利用してください。
- 広告・コメント・投げ銭・Shorts・ライブ配信・TV／iOS・自動音声認識・翻訳・YouTube独自のおすすめ解析は今回の動画プレイヤー操作互換の対象外です。

## 一次資料

- [YouTubeの移動・速度](https://support.google.com/youtube/answer/7509567?co=GENIE.Platform%3DAndroid&hl=ja)、[精密シーク・チャプター・グラフ](https://support.google.com/youtube/answer/12825599?co=GENIE.Platform%3DAndroid&hl=ja)、[ピンチズーム](https://support.google.com/youtube/answer/12820428?hl=ja)
- [YouTubeの画質](https://support.google.com/youtube/answer/91449?co=GENIE.Platform%3DAndroid&hl=ja)、[キーボード](https://support.google.com/youtube/answer/7631406?hl=ja)、[字幕](https://support.google.com/youtube/answer/100078?hl=ja)、[全画面](https://support.google.com/youtube/answer/72689?co=GENIE.Platform%3DDesktop&hl=ja)
- [Media3のHLS](https://developer.android.com/media/media3/exoplayer/hls)、[トラック選択](https://developer.android.com/media/media3/exoplayer/track-selection)

実装の回帰テスト・隔離したブラウザー・Android Viewの描画検証は行いますが、実Android端末の物理ジェスチャー／TalkBack／回線切替を網羅した実機比較ではありません。
