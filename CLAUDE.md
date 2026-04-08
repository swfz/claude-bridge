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
- `storage.js` -- `~/.claude-bridge/` への永続化
- `thread-store.js` -- スレッド CRUD

### クライアントのコンポーネント構成

- `App.jsx` -- 状態管理の中心。`sessionsRef` で sessions の最新値を参照（stale closure 対策）
- `ChatView.jsx` -- highlight.js は静的 import で13言語を登録。`EditDiff` は全文ハイライト後に行分割
- `ThreadPanel.jsx` -- リサイズハンドルは `widthRef` で useCallback の依存を空に

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

## テスト

```bash
npm test
```

テストファイルは `test/` 配下。tmux コマンドのモックには `mock.module()` (experimental) を使用。

テスト追加時:
- ユニットテストは純粋関数から。外部依存は `mock.module` でモック
- ファイル監視のテストは `tmpdir` + 実ファイル書き込みで
- WebSocket テストは `ws` ライブラリで軽量サーバーを立てて結合テスト
