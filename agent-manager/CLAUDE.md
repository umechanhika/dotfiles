# AgentManager (Swift)

## コードナビゲーション
- `.swift` の定義・参照・型確認は swift-lsp の go-to-definition / find-references / hover を優先する。
  同一ファイルを全文 Read で何度も読み直さない（SessionStore.swift / ContentView.swift で過去
  11回・8回の全文再読込が発生していた）。
- 全文が必要なときも、初回以降は offset/limit で変更箇所だけ読む。
