# ラジオ（1局・Web版）

ラジオは初期状態では無効です。有効にするとログイン済みの利用者が、ライブラリの **ラジオ → 聴く** から現在の番組に途中参加できます。サーバーのUTC時刻を基準に曲順を循環させるため、聴取者がいなくても進行します。曲の切り替わりに、短い読み込みが入ることがあります。

## 設定

管理者が、Web公開領域とは別の専用ディレクトリに配信許諾済みの新規MP3と `station.json` を置き、そのディレクトリの絶対パスをサーバーの `MIREA_RADIO_DIR` に設定します。Mireaプロセスには読み取り権限だけを与え、一般利用者からの書き込みを許可しないでください。設定・音源を変更する場合は、配信停止のうえ整合した組として交換し、再起動してください。初期化時に設定や音源が不正なら起動エラーになります。無効化するには環境変数を外して再起動します。

```json
{
  "name": "Sample Radio",
  "epoch": "2026-01-01T00:00:00.000Z",
  "tracks": [
    { "title": "Opening", "file": "opening.mp3", "durationMs": 12000 },
    { "title": "Interlude", "file": "interlude.mp3", "durationMs": 15000 }
  ]
}
```

- `epoch` は起動時点以前のUTC時刻。曲は1〜200件、各1〜600秒、音源1件につき16 MiB以下です。ファイル名には英数字・ピリオド・ハイフン・アンダースコアが使えます。サブディレクトリや外部へのリンクは不可。
- `durationMs` は目安ではなく音源の実再生長をミリ秒に丸めた値を設定してください。FFprobeなどで確認できます。宣言値が違うと無音や曲の途中切れが生じます。
- 番組情報も音源も既存のMireaログインが必要。匿名配信や限定メンバー用の別ACLはありません。音源はログイン済み全利用者が取得できる前提で選んでください。
- 今回は録音済み番組の循環のみです。ライブ入力、AzuraCastからの移行、アプリ版・バックグラウンド再生、ブラウザ上の配信管理は対象外です。

## 開発時の確認

`node --test tests/radio.test.js` と `node scripts/check-radio-ui.mjs`。後者はローカルのChromiumとFFmpegで合成した音源を使用します。Playwright同梱のChromiumがない場合は、環境変数 `MIREA_UI_BROWSER` に既存Chromiumの実行ファイルを指定できます。

## Saved playlist source (owner only)

To use an existing personal Mirea playlist instead of copying MP3 files to the station directory, use its ID in place of `tracks`:

```json
{
  "name": "Sample Radio",
  "epoch": "2026-01-01T00:00:00.000Z",
  "playlistId": "12345678-1234-4234-8234-123456789abc"
}
```

The station follows the saved order and the duration of each ready, normalized Mirea audio file (AAC/M4A). A track is eligible only when its owner has shelf access, the shelf is not private, the normalized file is 16 MiB or smaller, and its duration is between 1 and 600 seconds. Unusable track metadata is skipped. More than 200 otherwise eligible entries, a missing or empty playlist, or no eligible tracks leaves the station unavailable. This mode does not start new transcodes. The manifest-based MP3 mode remains unchanged.

The playlist belongs to one Mirea account. The station is available to that account on multiple signed-in devices, not to other users who happen to share access to the music shelf. Private shelves are excluded even when unlocked. Every new media request rechecks the authorization and the active program; bytes already downloaded by an authorized listener cannot be recalled.

The playlist order is captured at server startup. If a request detects a playlist edit or a change to the selected tracks' access or eligibility, the station stops accepting new requests until the service is restarted, rather than quietly changing order while people are listening. Removing a track or deleting its playlist also blocks the old media URLs. Set a new past-or-current UTC epoch before restarting if the revised lineup should restart at the beginning; retaining the epoch keeps the shared clock and applies it to the new lineup.

Run the synthetic saved-playlist browser check with `node scripts/check-radio-ui.mjs --saved-playlist`. It uses generated AAC tones and two sessions of the same account.

## 複数のラジオ局（Web、試験機能）

サーバー起動時に `MIREA_RADIO_STATIONS=1` を指定した場合のみ、Web版の「ラジオ」から局一覧を開けます。ログイン済みの利用者は「局を作る」で自分の音声プレイリストを選び、局名と公開範囲を指定します。初期値は非公開です。自分の局だけを編集・削除できます。局の削除では元のプレイリストや楽曲は消えません。旧試験局を同時に有効にした場合は「試験局を聴く」から開けます。Androidネイティブ、オフライン、未ログイン、外部向け配信は対象外です。

| 公開範囲 | 局一覧に表示 | 再生できる人 |
| --- | --- | --- |
| 公開 | ログイン済み利用者 | 全曲の本棚へのアクセス権を持つログイン済み利用者 |
| 限定公開 | 局の作成者だけ | 作成者、またはリンクを知り全曲の本棚にアクセスできるログイン済み利用者 |
| 非公開 | 局の作成者だけ | 作成者のみ |

「共有リンクを新しくする」または公開範囲を切り替えると以前の限定公開リンクは失効します。限定公開リンクが表示されるのは発行時のみです。秘密値はURLフラグメントで渡し、ブラウザからは専用ヘッダーに入れて送ります。サーバーは秘密値そのものを保存しません。再発行は共有済みのリンクも失効させます。公開局の局名は表示されるため、局名に共有したくない情報を含めないでください。元のプレイリスト名やID、曲名、音声は権限のない利用者に公開しません。

局の番組はプレイリストの保存順で繰り返し、同じ局は参加時刻に関係なく共通の時計で進みます。局のプレイリストを差し替えると、新しい起点で再開します。既存のプレイリストを編集すると、再起動なしで次の取得時に番組を再計算し、以前の音声URLは使えなくなります。再生時点で作成者が読めない曲、非公開の本棚、未変換や上限外の音声は編成されません。再生対象は従来同様、1〜600秒の変換済みAAC/M4A（1ファイル16 MiBまで、局あたり候補200件まで）です。聴取者が編成に含まれる全曲を読めない場合は、メタデータと音声の両方を返しません。既に端末が取得した音声までは回収できません。1アカウントにつき最大25局で、プレイリストを削除すると参照する局も削除されます。

複数局はスキーマ28で追加され、現在の版は起動時にSQLiteをスキーマ29へ更新します。以前のサーバー版へ戻す予定がある場合、更新前に対応するリカバリーポイントを確保してください。機能を無効化しても局の設定はDBに残ります。

## FM演出（追加の試験機能）

管理者が `MIREA_RADIO_STATIONS=1` と `MIREA_RADIO_FM_DIR`（配信用の準備済みパックの絶対パス）を設定したときだけ、Web版の局編集に「FM演出」が出ます。作成者はMCとジングルそれぞれの「なし・標準・こだわり」を選択し、利用可能な品質を試聴できます。既存局と新規局の初期値はどちらも「なし」です。

- **MC**: 標準は短めで落ち着いた案内、こだわりは間を取ったオリジナル台本。どちらもモデル付属の規約に従い、音声に読み上げクレジットを入れ、再生画面にも出典を表示します。
- **ジングル**: 標準は短いベル音、こだわりはステレオの伴奏を加えた別編成。既成音源は同梱しません。
- **番組**: 約4曲ごとの切れ目（短いプレイリストでは周回末）に、準備済みジングル・MCの順で挟みます。局の公開範囲と曲の本棚権限を各配信リクエストで確認します。テンポや曲名などから自動生成する機能、配信中のTTS、外部サービスとの連携はありません。演出設定を変更すると共通の放送時計が先頭に戻ります。
- **障害時**: 欠損・破損・ハッシュ不一致の演出は起動時に除外し、無音枠を残しません。素材の読み込みは起動時のみで、差し替えは準備済みの別ディレクトリを指定して再起動します。既存の再生ページは次の音源を先読みしますが、切り替え時に最新の番組と権限を再確認してから使います。環境によって切替時に短い間が出ることがあります。曲自体には音量補正を加えません。

### オペレーターの準備

1. ジングルだけ試す場合は、リポジトリの依存関係とFFmpeg/FFprobeを導入したうえで `node scripts/prepare-radio-fm.mjs --out NEW_PACK_DIR` を実行します。出力先は新規ディレクトリ。2種類のAAC/M4Aを生成し、符号化後のラウドネス・トゥルーピーク・長さ・サイズを測定してから公開できる状態にします。
2. MCを作る場合は、[VOICEVOX COREの公式手順](https://github.com/VOICEVOX/voicevox_core/blob/main/docs/guide/user/usage.md)でPython 3.11以降向けの公式パッケージ、対応ONNX Runtime、Open JTalk辞書をローカルに用意します。実際に使うVVMの規約・スタイルID・SHA-256を確認。たとえばNemoは[専用規約](https://voicevox.hiroshiba.jp/nemo/term/)のクレジット要件があり、声の規約はパッケージ付属文書を優先して確認します。モデルや音声はこのリポジトリに同梱しません。
3. `python scripts/render-radio-voicevox.py --help` で必要な引数を確認します。`--model-terms-reviewed` は、指定したVVMで用途とクレジットを確認してから使用します。表示・読み上げ双方のクレジットは必須です。出力された新規ディレクトリを `node scripts/prepare-radio-fm.mjs --out NEW_PACK_DIR --voice LOCAL_VOICE_RENDER_DIR` に渡します。台本は固定のオリジナル案内で、アカウント・局名・プレイリスト・曲名などは音声合成に渡しません。試聴して発音、聞きやすさ、音量差を確認してから有効化します。
4. `MIREA_RADIO_FM_DIR` を未設定にすれば音楽専用に戻せます。設定値はDBに保持します。DBのスキーマは29になります。他バージョンへロールバックする場合は、移行前の対応するリカバリーポイントを使ってください。

検証コマンド: `node --test tests/radio-fm.test.js`、`node scripts/check-radio-station-ui.mjs --fm`。ブラウザ試験は実際のAACジングルと合成エンジンの代わりのテスト用トーンを使います。音声提供者の発声・イントネーション・モデルの利用可否は別途実物で確認してください。

### Windows x64 C APIでの準備

公式のWindows x64 C API ZIP（CORE 0.17.1）を使う場合は、Python wheelの代わりに `--core-dll PATH_TO_VOICEVOX_CORE_DLL` を指定できます。64ビットWindowsでのみ有効です。配布元のSHA-256を確認したCORE・VOICEVOX ONNX Runtime・Open JTalk辞書・VVMを個別に用意して、既存インストールやシステムの設定は変更せず、絶対パスで指定します。CORE 0.17.1のC ABI以外は拒否します。

Nemoを選ぶ際は、[固定版VVMのREADME](https://github.com/VOICEVOX/voicevox_vvm/blob/0.17.1/README.md)と[Nemoの規約](https://voicevox.hiroshiba.jp/nemo/term/)を確認してください。固定版の `n0.vvm` の女声1はスタイルID 10005です。Nemo音声を使う場合の指定例は `--credit "VOICEVOX Nemo" --spoken-credit "ボイスボックス・ネモ"` です。別のVVMにこの表記を流用せず、該当する利用規約に従います。

本物の音声でローカルブラウザ試験を行う場合は、測定済みパックを作ってから `node scripts/check-radio-station-ui.mjs --fm-pack=ABSOLUTE_PACK_DIR` を実行します。ジングルからMC、MCから試験曲への遷移を、Web Audioで復号した信号で確認します。測定値には音源側のフェード、文頭・文末の間、ブラウザ内の切替時間が含まれます。

### 音量と配信曲の選択

Webラジオの「ラジオ音量」は利用者ごとにこのブラウザに保存されます。設定は曲・MC・ジングルで共通ですが、ほかのプレイヤーや他の視聴者に影響しません。

「ラジオ」→「局を作る」または「局を編集」→「曲を選ぶ」で、通常のコンテンツ一覧と同じカードから曲を選べます。タイトル・本棚で検索し、選んだ曲を並べ替えて、自分用の新しいプレイリストとして保存します。既存リストを選んでから開くと、その内容をコピーして編集できます。元のリストは変わりません。局の設定も保存すると、選んだ順序で共通の番組が流れます。非公開の本棚や放送条件に合わない音声は候補に入りません。聴いている途中に自分だけ別の曲へ飛ばす機能ではありません。

### 曲間の自動MC

追加で `MIREA_RADIO_DYNAMIC_CONFIG` にローカル生成設定JSONの絶対パスを指定すると、MCを有効にした局では、前の曲から次の曲（プレイリストの末尾から先頭も含む）への案内を周回ごとに事前生成します。局名と次曲名から、ローカルで用意した日本語台本の言い回しを順送りし、VOICEVOX Nemoを含む確認済みのモデルで合成します。外部AI、リスナーごとの合成、曲名の外部送信は行いません。試聴ボタンは引き続き品質サンプルで、実際の番組の曲間案内と同じ台本ではありません。

- 複数の聴取者は一つの確定した周回と音声を共有します。途中から届いた音声で進行が変わることはありません。初回はまず音楽のみ、締切までに用意できた案内は次の周回で追加します。レンダリングの失敗・期限切れ・混雑では空枠を残さず次曲へ進みます。再起動すると一時キャッシュは破棄され、既存の運用設定から組み直します。
- 既存の曲解析が現在の原音・再生時間と一致し、短いイントロ区間が確認できた場合は、こだわり設定でも短い案内を選ぶことがあります。再解析は行いません。イントロの区間名から歌声がないとは判断しないため、MCは曲に重ねません。
- ジングルを有効にすると、オリジナルの短い音型からMCに入り、声が出たところで伴奏を下げます。曲の音声には加工せず、案内側をフェードとラウドネス測定で整えます。ブラウザで次素材を先読みしますが、完全なギャップレスを保証するものではありません。
- 一度に1ジョブ、最大6局・各周回24案内を対象とします。24を超える曲間は、次の周回で対象位置をずらします。用意済みの直近と次の周回だけをメモリに保持し、中間WAVは作業完了後に消します。機能設定がない場合、従来の固定MC動作のままです。アカウント・局・全配信曲のアクセス権は従来どおり検査します。

ローカル生成設定には、確認済みの `python`、CORE 0.17.1 C APIの `core` DLL、`onnx` DLL、`dictionary` ディレクトリ、`model` VVMの絶対パス、`modelSha256`、`style`、`credit`、`spokenCredit`、`modelTermsReviewed: true` を指定します。Windows x64と、実機検証ゲート付きのLinux glibc x64向けです。バイナリやモデルは同梱しません。Linux梱包と運用条件は[専用手順](operations/radio-voicevox-linux.md)を参照してください。

実機ローカル試験: `node scripts/check-radio-dynamic-ui.mjs ABSOLUTE_CONFIG_JSON ABSOLUTE_PACK_DIR`。検証済みモデルと試験曲だけを使い、二人の途中参加、次曲への遷移、同じ曲間でも次の周回では別のアナウンスになること、権限の取り消しを確認します。

### AutoDJ：複数プレイリストで回す

局の管理者は、主リストを先頭に1〜5件の自分の音声プレイリストを登録できます。保存順モードは、主リスト、2件目以降のリストを指定順に回し、各リストでは保存順を使います。同じ曲が複数にある場合は最初の一度だけ採用し、全体で最大200曲です。シャッフルは周回ごとに共通の並びを決め、途中参加した聴取者やブラウザを開き直した聴取者も同じ進行を受け取ります。自分だけ次へ飛ばす機能ではありません。2曲だけの場合は、周回の境目で同じ曲が続かないよう、シャッフルで決まった順を維持します。

- 既存局は追加設定なしで従来どおり1件のリストを保存順で再生します。主リスト、追加リストの並び、保存順／シャッフルを変えて保存した場合は、その時点を新しい共通の起点にします。局名やリスト名だけの変更では、順序と時刻を変更しません。既に事前生成されたMCには、生成時点の名前が次の準備済み周回まで残る場合があります。
- 動的MCはシャッフル後に本当に続く曲を案内します。再起動で一時音声を失ったあとも、音楽ローテーションは永続化された起点から再開し、動的MCは再び準備できた周回から入ります。生成済みMCにより長くなった周回の位置や音声を再起動後に完全復元するわけではありません。
- 再生条件を満たさない曲は除外します。元リストが削除された場合や、所有者が読めない・再生可能な曲がなくなった元リストがある場合は、他のリストだけで勝手に続けず停止します。配信範囲は局の設定、全配信曲は既存の本棚権限に従います。聴取者にリストのIDや設定は出しません。
- スキーマ30の追加です。週次予約、リクエスト曲、詳細な再生履歴はこの機能に含みません。

### 曲同士のクロスフェード

局の設定で有効にすると、対象の曲同士を2.4秒重ねます。初期値はオフです。すべての端末に同じ開始時刻と重なり時間を返し、途中から聴き始めた場合でもその時点の位置から再生します。2曲とも、通常の局や本棚の再生権限が必要です。

- 曲の途中に入る自動MC、曲間のMCやジングルとは別の機能です。曲間にMC・ジングルがある部分、周回の末尾から先頭、短い曲のある放送計画には適用しません。曲間の自動MCが有効な局では、自動MCを優先して通常の進行を維持します。
- 5.05秒未満の曲がある場合、3曲が同時に重なるのを防ぐため、その局ではクロスフェードしません。
- スキーマ31の追加です。先に旧バージョンのDBをバックアップしてください。戻す場合は移行前バックアップを使います。

### 動的MCの間隔と短いトーク

自動MCは原則として2曲に1回です。曲数が奇数でも、プレイリストの周回をまたいで同じ間隔を保ちます。次曲案内の前に短い雑談を入れますが、音源を準備できなかった回はそのまま次の曲へ進みます。再起動直後の準備前の周回や、1周に24件の生成上限を超える部分でもトークは入りません。AIによる未確認情報の読み上げや、自動のニュースサイト取得は行いません。

運用担当者が `MIREA_RADIO_HEADLINES_FILE` にレビュー済み見出しJSONの絶対パスを設定した場合に限り、1周につき最大1枠で出典つきの短いニュースを読みます。入力は `{version:1,dateJst,items}`（16 KiB以下、最大8件）。各項目は `sourceName`、承認済み公的サイトの `sourceUrl`、JSTの `publishedAt` と `expiresAt`、55文字以下の日本語要約 `summaryJa`、`editorialStatus:"verified-paraphrase"` が必要です。公開時刻・期限を含むすべての想定放送範囲を当日JSTに収めます。アプリは公開ページにアクセスせず、入力を自動作成・更新しません。古い、未確認、重複、期限不足、入力なしの場合は通常の雑談です。入力ファイルは局の投稿・配信とは別に管理します。

音楽構成の新規解析では、モデルの候補区間を曲の長さで切り詰め、不正・矛盾する区間を整理してから保存します。有効かつ一意な従来IDは維持するので、対応する手動修正はそのまま使えます。既存の解析や手動修正は一括で書き換えません。短いイントロと後続区間を連続して確認できる場合だけMCの長さの目安に使い、AIの「イントロ」「間奏」表示だけで無歌唱と判断しません。モデル・重みは変更していません。
