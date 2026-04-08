# Claude Bridge

Claude Code のセッションをブラウザから操作・閲覧できる Web ブリッジ。

node-pty で新規セッションを起動する方式と、既存の tmux ペインに接続する方式の両方をサポート。

## 機能

- **セッション管理** -- 新規作成 / 既存セッション resume / tmux ペイン接続
- **Chat ビュー** -- JSONL ファイルからメッセージをパースし Markdown レンダリング
- **Raw ビュー** -- xterm.js によるターミナル表示
- **ツール呼び出し表示** -- Bash, Read, Edit 等の実行を折りたたみ表示、Edit は diff + シンタックスハイライト
- **スレッド / コメント** -- メッセージへのインラインスレッド・メモ機能
- **ファイルプレビュー** -- `file://` リンクをサイドドロワーでプレビュー
- **WebSocket 自動再接続** -- 切断時に 2 秒後に自動再接続、ping/pong による死活監視

## 前提条件

- Node.js 24+
- Claude Code CLI (`claude`) がインストール済み
- tmux ペイン接続を使う場合は tmux が起動中であること
- node-pty のビルドに C++ コンパイラ (`gcc`/`g++`) と `make` が必要

## セットアップ

```bash
npm run install:all
npm rebuild node-pty   # ネイティブモジュールのビルド
```

## 起動

```bash
# クライアントビルド + サーバー起動（http://localhost:3000）
npm run dev

# サーバーのみ起動（ビルド済み前提）
npm start
```

## スクリプト一覧

| スクリプト | 説明 |
|---|---|
| `npm run dev` | クライアントビルド後にサーバー起動 |
| `npm start` | サーバーのみ起動（`client/dist` 配信） |
| `npm run build` | クライアントのプロダクションビルド |
| `npm run dev:client` | Vite dev server（ホットリロード開発用） |
| `npm test` | テスト実行 |
| `npm run install:all` | ルート + クライアントの依存インストール |

## アーキテクチャ

```
server/
  index.js            Express + WebSocket サーバー、メッセージルーティング
  session.js           node-pty による Claude プロセス管理
  tmux-session.js      tmux ペイン接続 (send-keys / capture-pane)
  jsonl-watcher.js     JSONL ファイル監視、チャットメッセージ配信
  jsonl-utils.js       共通ユーティリティ (テキスト抽出, ツール情報抽出)
  claude-sessions.js   Claude セッション一覧・履歴読み込み
  storage.js           ~/.claude-bridge/ への JSON 永続化
  thread-store.js      スレッドの CRUD

client/
  src/
    App.jsx            メインアプリケーション、WebSocket 管理
    components/
      ChatView.jsx     Markdown チャット表示、ツール呼び出し表示
      TerminalView.jsx xterm.js ターミナル
      SessionTabs.jsx  セッションタブ切り替え
      ThreadPanel.jsx  スレッドサイドパネル（リサイズ可）
      InputBar.jsx     テキスト入力
      NewSessionDialog.jsx  新規/resume/tmux セッション作成
      PreviewDrawer.jsx     ファイルプレビュードロワー
      ...
    hooks/
      useWebSocket.js  WebSocket 接続管理（自動再接続）
      useChatParser.js チャットメッセージパーサー

test/                  node:test によるユニット・統合テスト
```

## メッセージプロトコル (WebSocket)

### クライアント → サーバー

| type | 説明 |
|---|---|
| `new_session` | 新規セッション作成 |
| `input` | セッションにテキスト送信 |
| `resize` | ターミナルリサイズ |
| `kill_session` | セッション終了 |
| `restart_session` | 過去セッションを再起動 |
| `resume_session` | Claude セッションを `--resume` で再開 |
| `attach_tmux_pane` | tmux ペインに接続 |
| `detach_tmux_pane` | tmux ペインから切断 |
| `list_tmux_panes` | Claude 実行中の tmux ペイン一覧 |
| `get_buffer` | ターミナル出力バッファ取得 |

### サーバー → クライアント

| type | 説明 |
|---|---|
| `session_list` | セッション一覧（接続時 + 変更時に送信） |
| `output` | ターミナル出力 |
| `chat_message` | JSONL から読み取ったチャットメッセージ |
| `session_history` | セッション履歴（resume/tmux 接続時） |
| `output_buffer` | ターミナル出力バッファ |
| `tmux_panes` | tmux ペイン一覧 |

## テスト

```bash
npm test
```

`node:test` を使用。`--experimental-test-module-mocks` で tmux コマンドのモックテストを実行。

## セキュリティ

- `/preview` エンドポイントはパス正規化 + シンボリックリンク拒否でトラバーサル攻撃を防止
- tmux paneId は `%<数字>` 形式のバリデーションでシェルインジェクションを防止
- WebSocket に認証はないため、ローカルネットワークでの使用を前提とする

## ライセンス

MIT
