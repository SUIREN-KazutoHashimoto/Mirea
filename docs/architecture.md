# アーキテクチャ

現行設計は、責務と状態遷移を追えるように分冊しています。[全体構成](design/overview.md)から読み始めてください。

|知りたいこと|設計書|
|---|---|
|コンポーネント・起動順序・信頼境界|[全体構成](design/overview.md)|
|所有者・削除・保存先・移行|[データモデル](design/data-model.md)|
|全テーブル・列・外部キー・索引・トリガー|[schema25のデータ辞書](design/schema-reference.md)|
|送信、後処理、並列数、再起動時の復旧|[アップロードとジョブ](design/upload-jobs.md)|
|動画・音声・書籍・先読み・続き位置|[再生と閲覧](design/playback.md)|
|PDF・画像書籍・EPUBの検査と制限|[書籍の詳細](design/books.md)|
|カタログ、暗号化保存、7日の許可|[オフライン同期](design/offline-sync.md)|
|認証・認可・プライベート本棚・診断|[セキュリティ](design/security.md)|
|WebView、サービス、端末鍵、更新|[Android](design/android.md)|
|理由・制約・変更時の観点|[設計判断](design/decisions.md)|
|API形式と全ルート|[API](api.md)・[登録一覧](reference/api-routes.md)|

これらはMirea 1.0.0の説明です。配布版を調べるときはそのGitタグのコード・文書を参照してください。試験方針の記載は、全端末で実機検証済みという意味ではありません。
