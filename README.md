# Claude Bridge

Claude Code のセッションをブラウザから操作・閲覧できる Web ブリッジ。

node-pty で新規セッションを起動する方式と、既存の tmux ペインに接続する方式の両方をサポート。

## 機能

- **セッション管理** -- 新規作成 / 既存セッション resume / tmux ペイン接続
- **Chat ビュー** -- JSONL ファイルからメッセージをパースし Markdown レンダリング
- **Raw ビュー** -- xterm.js によるターミナル表示
- **ツール呼び出し表示** -- Bash, Read, Edit 等の実行を折りたたみ表示、Edit は diff + シンタックスハイライト
- **レビュー / コメント** -- レビュー（指摘を溜めて Claude へ一括送信）と、送信せず残すコメント（参照専用）。プレビューでは該当箇所に 💬 マーカーを表示。スレッドも利用可
- **agent view 連携** -- `claude agents` のセッションを閲覧し、レビューを inbox 経由で届ける（[agent 連携](#agent-連携レビュー送信--コメント) 参照）
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

| スクリプト                 | 説明                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`              | クライアントビルド後にサーバー起動                                          |
| `npm start`                | サーバーのみ起動（`client/dist` 配信）                                      |
| `npm run build`            | クライアントのプロダクションビルド                                          |
| `npm run dev:client`       | Vite dev server（ホットリロード開発用）                                     |
| `npm test`                 | テスト実行                                                                  |
| `npm run install:all`      | ルート + クライアントの依存インストール                                     |
| `npm run setup:hooks`      | agent 連携フック（レビュー送信の受信側）を `~/.claude/settings.json` に登録 |
| `npm run setup:statusline` | レート制限表示用の statusLine tee を `~/.claude/settings.json` に登録       |

## agent 連携（レビュー送信 / コメント）

「送る（レビュー）」と「残す（コメント）」は別物として扱う。

- **コメント（残す）** -- 送信されず `~/.claude-bridge/` に保存されるだけの参照用メモ。ブラウザ側だけで完結するため**追加設定は不要**。
- **レビュー（送る）** -- 溜めた指摘を Submit すると対象セッションへ届く。送信先はセッション種別で自動的に出し分ける。
  - 通常セッション（new / resume / tmux）= PTY に直接入力。
  - 閲覧 / agent view セッション = **inbox 経由**（`~/.claude-bridge/inbox/<claudeSessionId>.jsonl`）で、対象の Claude 側フックが取り込む。

### inbox 経由のレビューを使うには `setup:hooks` が必要（受信側）

inbox 経由の配信は、**届け先の Claude（agent）が動いている環境**にブリッジ同梱フックが登録されている前提。次を実行する：

```bash
npm run setup:hooks
```

- フックは**グローバル**の `~/.claude/settings.json` にマージ登録される（既存設定は壊さない）。
- 重要なのは「**ブリッジサーバーを動かす環境**」ではなく「**レビューを届けたい Claude セッションを動かす環境**」で実行すること。別マシン / 別ユーザーで agent を動かしているなら、その環境で `setup:hooks` を実行する。
- 登録されるフック（`scripts/hooks/`）:
  - `bridge-check-inbox.js` -- 応答終了時（Stop hook）に未読 inbox を取り込む（主経路）
  - `bridge-session-start.js` / `bridge-watch.js` -- インタラクティブセッション向けのリアルタイム受信（Monitor）
- サンドボックス有効時は `setup:hooks` が `~/.claude-bridge` への書き込み許可も追加する。
- コメント（残す）だけを使う場合は `setup:hooks` は不要。

## レート制限表示（ヘッダーの 5h/7d メーター）

credentials・外部 API アクセスは一切使わず、Claude Code の statusLine 機構に相乗りしてローカルファイル経由でデータを取る。

```bash
npm run setup:statusline
```

- `~/.claude/settings.json` の `statusLine.command` に `scripts/statusline/bridge-statusline-tee.js` を割り込ませる。既存の statusLine コマンドは `<dataDir>/statusline-original.json` に退避され、tee は stdin の `rate_limits` だけを `<dataDir>/rate-limits.json` に書き出した後、元のコマンドへ stdin をそのまま引き継ぐ（表示は変わらない）。
- **ブリッジサーバーを動かす環境ではなく、statusLine を表示させたい Claude セッションを動かす環境**で実行する。
- 元に戻す場合: `node scripts/setup-statusline.js --uninstall`
- statusLine 未連携（`npm run setup:statusline` 未実行）でもブリッジ自体は問題なく動作し、ヘッダーのメーターが表示されないだけ。

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

| type               | 説明                                  |
| ------------------ | ------------------------------------- |
| `new_session`      | 新規セッション作成                    |
| `input`            | セッションにテキスト送信              |
| `resize`           | ターミナルリサイズ                    |
| `kill_session`     | セッション終了                        |
| `restart_session`  | 過去セッションを再起動                |
| `resume_session`   | Claude セッションを `--resume` で再開 |
| `attach_tmux_pane` | tmux ペインに接続                     |
| `detach_tmux_pane` | tmux ペインから切断                   |
| `list_tmux_panes`  | Claude 実行中の tmux ペイン一覧       |
| `get_buffer`       | ターミナル出力バッファ取得            |

### サーバー → クライアント

| type              | 説明                                    |
| ----------------- | --------------------------------------- |
| `session_list`    | セッション一覧（接続時 + 変更時に送信） |
| `output`          | ターミナル出力                          |
| `chat_message`    | JSONL から読み取ったチャットメッセージ  |
| `session_history` | セッション履歴（resume/tmux 接続時）    |
| `output_buffer`   | ターミナル出力バッファ                  |
| `tmux_panes`      | tmux ペイン一覧                         |

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
