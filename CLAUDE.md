# CLAUDE.md

Claude Code がこのリポジトリで作業する際の指針。

## プロジェクト概要

Claude Code セッションをブラウザから操作する Web ブリッジ。Express + WebSocket サーバーと React クライアントで構成。

## コマンド

```bash
npm run dev          # ビルド + サーバー起動 (http://localhost:3000)
npm start            # サーバーのみ起動（ビルド済み前提）
npm run build        # クライアントビルド
npm test             # テスト実行
npm run install:all  # 全依存インストール
npm run setup:hooks  # agent view 連携フックを ~/.claude/settings.json に登録
```

## アーキテクチャ

- `server/` -- Node.js (ESM)。Express + ws で WebSocket サーバーを提供
- `client/` -- React + Vite。ビルド成果物は `client/dist/` に出力され、サーバーが配信
- `test/` -- `node:test` によるテスト。`--experimental-test-module-mocks` 使用

### サーバーのモジュール構成

- `index.js` -- エントリポイント。メッセージルーティング。ヘルパー `findSession()` / `broadcastSessionList()` でセッション操作を集約
- `session.js` -- node-pty セッション管理 (`Session`, `SessionManager`)
- `tmux-session.js` -- tmux ペイン接続 (`TmuxSession`, `TmuxSessionManager`)。paneId は `%<数字>` 形式のバリデーション必須
- `jsonl-watcher.js` -- JSONL ファイルの監視。`attachExisting` モードで既存セッションにも接続可能
- `jsonl-utils.js` -- 共通ユーティリティ。`extractTextContent`, `extractToolUses`, `CLAUDE_PROJECTS_DIR` 等。jsonl-watcher.js と claude-sessions.js から参照
- `claude-sessions.js` -- Claude セッション一覧・履歴読み込み
- `storage.js` -- `~/.claude-bridge/` への永続化。`appendInbox()` で agent への送信を inbox に書き込む
- `claude-agents.js` -- `claude agents --json` から agent view のセッション一覧を取得
- `thread-store.js` -- スレッド CRUD

### クライアントのコンポーネント構成

- `App.jsx` -- 状態管理の中心。`sessionsRef` で sessions の最新値を参照（stale closure 対策）
- `ChatView.jsx` -- highlight.js は静的 import で13言語を登録。`EditDiff` は全文ハイライト後に行分割
- `ThreadPanel.jsx` -- リサイズハンドルは `widthRef` で useCallback の依存を空に

### agent view 連携（フックベース送信）

`claude agents` の各セッションをブラウザから閲覧・コメント・送信する仕組み。tmux ミラー（TUI 画面共有・自動操作）は脆弱だったため廃止し、agmsg 方式のフックベース送信に統一した。

- **閲覧（メインタブに統合）**: `AgentSidePanel`（ヘッダ「Agents」トグル）は**一覧ランチャー**に専念。agent をクリックすると、その会話を**メインタブに `readonly` セッションとして開く**（既存の「閲覧（コメント）」と同じ `handleOpenReadonly` 経路）。会話は大画面で表示。会話が空のセッション（JSONL が `ai-title`/`agent-name` のみ）は表示が空になる（正常）
- **送信（readonly セッションの送信欄）**: readonly タブの下部 `InputBar` から `send_to_agent` → `storage.appendInbox` で `~/.claude-bridge/inbox/<sessionId>.jsonl` に追記。readonly は PTY を持たないため通常の input ではなく inbox 経由で送る。宛先は `claudeSessionId` 直接なので突合・誤送信の懸念なし
  - 送信経路の整理: 通常セッション（new/resume/tmux）＝PTY に直接 input / readonly（agent view・閲覧とも）＝inbox 経由（`send_to_agent`）
- **配信**（agent 側で受信）: claude-bridge 同梱フックを**グローバル** `~/.claude/settings.json` に登録（`npm run setup:hooks`）。
  - **turn 配信（Stop hook）が主**。応答終了ごとに発火するため確実だが、対象が idle だと次の応答まで届かない
  - **monitor（SessionStart→Monitor）は interactive 向け**。background（agent view の dispatch）セッションは additionalContext の指示を実行せず Monitor が立たないため、background へは実質 turn 配信になる（agmsg も同様で background は対象外）
- **サンドボックス**: サンドボックス有効時、Stop/SessionStart の hook 本体はホスト権限で動くが、**Monitor が起動する watcher 子プロセスは Bash と同じサンドボックス制限**を受け、`~/.claude-bridge` への書き込みが EROFS になる。`setup:hooks` が `sandbox.filesystem.allowWrite` に inbox を追加して回避する（`sandbox.enabled` は変更しない）
  - `scripts/hooks/bridge-check-inbox.js` -- Stop hook（turn 配信）。応答終了時に未読を `{decision:"block", reason}` で注入。`stop_hook_active` で無限ループ回避、monitor watcher 生存時（pidfile）は defer
  - `scripts/hooks/bridge-session-start.js` -- SessionStart hook（monitor 配信）。Monitor ツールで `bridge-watch.js` を `persistent` 実行する指示を `hookSpecificOutput.additionalContext`（JSON）で出す。plain text では additionalContext として注入されないため JSON 必須。additionalContext は次のユーザー入力への応答時に読まれるため、起動直後・入力前には Monitor は立たない
  - `scripts/hooks/bridge-watch.js` -- inbox を poll し新着を `[claude-bridge] <本文>` で stdout（Monitor がリアルタイムに push）
- 既読位置は `inbox/<sessionId>.offset` で管理（サーバーは書くだけ、offset 更新はフック側）
- テスト時は `CLAUDE_BRIDGE_DIR` 環境変数で inbox の位置を上書きできる

## コーディング規約

- サーバーは ESM (`"type": "module"`)
- `execSync` は使わない。非同期 (`execAsync = promisify(exec)`) を使用
- 重複コードは `jsonl-utils.js` 等の共通モジュールに集約する
- React フック: 条件分岐やリターンより前に呼ぶ (Rules of Hooks)
- テストは `node:test` の `describe`/`it` を使用。外部テストランナー不要

## セキュリティ

- `/preview` エンドポイント: `path.resolve()` で正規化、`lstatSync()` でシンボリックリンク拒否
- tmux コマンド: paneId は `validatePaneId()` で `%<数字>` 形式を検証してからシェルに渡す
- `escapeForShell()` でテキストをシングルクォートエスケープ
- WebSocket 認証はなし（ローカル前提）
- inbox: `appendInbox()` の sessionId は `/^[\w-]+$/` で検証（パストラバーサル対策）。ファイルは `0600`。**平文保存のため機微情報を送らない**
- フック登録（`setup:hooks`）は `~/.claude/settings.json` を**既存設定を壊さずマージ**（claude-bridge 由来は marker で除去して再追加）

## テスト

```bash
npm test
```

テストファイルは `test/` 配下。tmux コマンドのモックには `mock.module()` (experimental) を使用。

テスト追加時:
- ユニットテストは純粋関数から。外部依存は `mock.module` でモック
- ファイル監視のテストは `tmpdir` + 実ファイル書き込みで
- WebSocket テストは `ws` ライブラリで軽量サーバーを立てて結合テスト
