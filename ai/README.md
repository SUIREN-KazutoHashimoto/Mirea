# ローカルAI実行コード

モデルの重みはこのディレクトリにも配布物にも含めません。管理者が利用条件を確認し、モデル管理画面または専用取得コマンドで別途導入します。

- [管理者向け導入手順](../docs/operations/ai.md)
- [利用者向け操作](../docs/user/ai.md)
- [設計](../docs/design/ai-2.0.0.md)

`runtime-versions.json` は llama.cpp / whisper.cpp の固定コミットです。`music.py` は All-In-One と HTDemucs の別途取得済み重みをCPUで使います。純粋なPyTorch演算による `neighborhood.py` を使い、CUDAやNATTEN拡張は要求しません。Vulkanは llama.cpp と、対応するビルドがある場合の whisper.cpp に使用します。音楽の構成解析はCPUで実行します。

`bin/` は管理者が導入した実行コードだけの保存先で、Gitとソース配布の対象外です。実行エンジンとPython依存物の利用条件・NOTICEは導入先の `LICENSE.runtime` / `notices/` へ保存します。モデル固有の利用条件はモデル管理の導入記録に保持します。

Linuxでは `executor.c` をコンパイルした非特権ランチャーで推論の外向き通信を拒否します。モデルの取得をするNode側の専用処理と、推論プロセスを分離しています。
