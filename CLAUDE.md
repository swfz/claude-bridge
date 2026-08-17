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
- `running-sessions.js` -- ホーム画面用。`~/.claude/sessions/*.json`（pid/sessionId/cwd/name/status/tmux）を読み、`ps` の生存 PID で絞って「今起動中の Claude セッション」を返す。`tmux` フィールドの paneId は `%<数字>` 形式のみ採用
- `thread-store.js` -- スレッド CRUD

### クライアントのコンポーネント構成

- `App.jsx` -- 状態管理の中心。`sessionsRef` で sessions の最新値を参照（stale closure 対策）
- `ChatView.jsx` -- highlight.js は静的 import で13言語を登録。`EditDiff` は全文ハイライト後に行分割
- `ThreadPanel.jsx` -- リサイズハンドルは `widthRef` で useCallback の依存を空に
- `HomeView.jsx` -- ホーム画面（起動中セッション一覧）。`utils/runningSessions.js` の純粋関数で突合・整形

### ホーム画面（起動中セッション一覧）

タブの左端の「⌂ Home」で開く既定画面。今このマシンで起動している Claude セッションを一覧し、ブリッジのタブとして開いているものを区別する。

- データ源は `list_running_sessions` → `running_sessions`（`server/running-sessions.js`）。ブリッジのタブ（`session_list`）とは独立した情報で、突合はクライアントの `utils/runningSessions.js`（`annotateRunningSessions` / `findOpenTab`）が行う
- 突合キーは `claudeSessionId` 優先、無ければ `claudePid`（tmux タブは JSONL 未解決でも pid は分かる）。死んだタブは「開いている」と扱わない
- 開いているセッションには「タブで表示中」バッジ＋左の色帯が付き、クリックでそのタブへ移動。未オープンは tmux ペインがあれば `attach_tmux_pane`、無ければ `open_readonly_session`（閲覧）で開く
- 起動中セッションに紐づかないタブ（閲覧で開いた過去セッション・終了したタブ）は下段の「その他の開いているタブ」に出す
- ホーム表示は `showHome` state（localStorage 記憶）。`activeSessionId` は保持したまま切り替えるため Home ⇄ 作業中タブを往復できる。一覧はホーム表示中のみ 5 秒間隔でポーリングする

### agent view 連携（フックベース送信）

`claude agents` の各セッションをブラウザから閲覧・コメント・送信する仕組み。tmux ミラー（TUI 画面共有・自動操作）は脆弱だったため廃止し、agmsg 方式のフックベース送信に統一した。

- **閲覧（メインタブに統合）**: `AgentSidePanel`（ヘッダ「Agents」トグル）は**一覧ランチャー**に専念。agent をクリックすると、その会話を**メインタブに `readonly` セッションとして開く**（既存の「閲覧（コメント）」と同じ `handleOpenReadonly` 経路）。会話は大画面で表示。会話が空のセッション（JSONL が `ai-title`/`agent-name` のみ）は表示が空になる（正常）
- **送信（readonly セッションの送信欄）**: readonly タブの下部 `InputBar` から `send_to_agent` → `storage.appendInbox` で `~/.claude-bridge/inbox/<sessionId>.jsonl` に追記。readonly は PTY を持たないため通常の input ではなく inbox 経由で送る。宛先は `claudeSessionId` 直接なので突合・誤送信の懸念なし
  - 送信経路の整理: 通常セッション（new/resume/tmux）＝PTY に直接 input / readonly（agent view・閲覧とも）＝inbox 経由（`send_to_agent`）
- **レビュー（送る）と コメント（残す）の役割分担**: 「送る」と「残す」を完全に分離し、どちらも**メッセージ単位ではなくセッション単位**で扱う。保存キーは共通で `claudeSessionId`（無ければブリッジ ID）＝`sessionKey`（サーバーは `sessionKeyOf()` で解決・パストラバーサル検証）。ヘッダの「Review」「Memo」トグルでそれぞれのサイドパネルを開く（readonly 含む全種別、chat ビュー時）。
  - **レビュー＝送る（pending review）**: `ReviewDraftPanel` で指摘を溜める。`save_review`/`get_review` で下書きを `review-<key>.json` に永続化（リロード/再オープンしても残る）。「Submit」で `submit_review` を投げると、**サーバーが対象セッション種別で送信先を出し分ける**（`readonly` → `storage.appendInbox(claudeSessionId)` ＝inbox / それ以外（PTY あり）→ `session.write` ＝Claude へ）。送信本文は `[レビュー N件] ...`。Submit 成功で下書きはクリア。ファイルプレビュー（`PreviewDrawer` の `reviewMode` + `ReviewPanel`）のファイルレビューも同じ `submit_review` 経由（各項目にファイル名を前置）で、readonly でも届く。
  - **コメント＝残す（参照専用）**: `save_comment`/`get_comments`/`delete_comment` ↔ `CommentPanel`（入力欄つき一覧）。`comments-<key>.json` に保存し**送信は一切しない**。セッションに対して残し、再オープン/resume/閲覧をまたいで参照できる。
  - メッセージ単位の Memo/Review ボタンや `CommentPopover`、`send_comment_to_claude` は廃止（`Thread` だけは別機能としてメッセージ単位で残存）。
  - **プレビュー上の選択コメント**: コード/テキスト/Markdown は drawer 本文（`bodyRef`）の `mouseup` で選択を拾う。**HTML は iframe に描画されるため親の選択 API では拾えない**ので、`iframe.contentDocument` に直接 `mouseup` を張る（`/preview` は同一オリジンで `sandbox="allow-scripts allow-same-origin"` なのでアクセスできる）。ポップアップ位置は iframe の矩形分オフセットして本文座標に変換する。行・列は HTML ソースを別途 `fetch` し、表示テキスト上の出現順（`getOccurrenceIndex`）と同じ出現をソース内で探して（`findOccurrenceOffset`）算出する（`buildLocationInfo` の `kind: "html"`）。iframe 内には 💬 ガターは出せないので、位置は保存された `anchor.line`／ラベルで示す
- **配信**（agent 側で受信）: claude-bridge 同梱フックを**グローバル** `~/.claude/settings.json` に登録（`npm run setup:hooks`）。
  - **turn 配信（Stop hook）に一本化**。応答終了ごとに発火し、inbox の未読をまとめて `{decision:"block", reason}` で注入する。対象が idle の場合は次の応答時に届く。常駐プロセス（monitor）は PID 再利用・サンドボックス・応答途中への割り込みで誤動作が多く廃止した
  - `scripts/hooks/bridge-check-inbox.js` -- Stop hook（turn 配信）の本体。応答終了時に未読を注入。`stop_hook_active` で無限ループ回避
- 既読位置は `inbox/<sessionId>.offset` で管理（サーバーは書くだけ、offset 更新はフック側）
- **claude-bridge の介入範囲（誤解防止）**: bridge が会話に作用するのは Stop hook（`bridge-check-inbox.js`）による**注入のみ**。注入文には必ず `[claude-bridge]` マーカーが付き、「UI 由来のユーザーメッセージでツール実行結果ではない」と明記される。注入の事実は `~/.claude-bridge/delivery.log`（JSONL: `ts`/`sessionId`/`count`/`texts`）に全文記録される。**Bash 等のツールの標準出力には一切介入しない（構造上できない）**。ツール出力の不整合を bridge のせいと疑う前に、まず `delivery.log` を確認すること（該当セッションの注入記録が無ければ bridge は無関係）
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
