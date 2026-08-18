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
npm run setup:hooks       # agent view 連携フックを ~/.claude/settings.json に登録
npm run setup:statusline  # レート制限表示用の statusLine tee を ~/.claude/settings.json に登録
```

## アーキテクチャ

- `server/` -- Node.js (ESM)。Express + ws で WebSocket サーバーを提供
- `client/` -- React + Vite。ビルド成果物は `client/dist/` に出力され、サーバーが配信
- `test/` -- `node:test` によるテスト。`--experimental-test-module-mocks` 使用

### サーバーのモジュール構成

- `index.js` -- エントリポイント。メッセージルーティング。ヘルパー `findSession()` / `broadcastSessionList()` でセッション操作を集約。`ws.on("message")` は async（選択肢プロンプトの読み取りで await する）なので、各 case は自分で try/catch する
- `session.js` -- node-pty セッション管理 (`Session`, `SessionManager`)。生の ANSI 出力は `@xterm/headless` の端末にも流し、`getScreenText()` で「今の画面」を復元できる（選択肢プロンプトのパース用）。**`write()` は本文と末尾の確定用 Enter を分けて送る**（一括で書くと Claude Code の TUI が「複数行入力の改行」と扱って送信されず、入力欄に残ったままになる）
- `tmux-session.js` -- tmux ペイン接続 (`TmuxSession`, `TmuxSessionManager`) と、新しい window で `claude --resume` を起こす `resumeInTmuxWindow()`。paneId は `%<数字>` 形式のバリデーション必須。画面取得は `capturePane()`、選択肢の操作は `sendChoiceKeysToPane()` / `sendChoiceTextToPane()`（`sendKeysToPane()` と違い Enter を付けない）
- `choice-prompt.js` -- 画面テキストから選択肢プロンプトを構造化する純粋関数 `parseChoicePrompt()`
- `choice-keys.js` -- 選択肢操作のキー表現。抽象キー名のホワイトリスト（`assertValidChoiceKeys`）と PTY 用シーケンス変換（`toPtySequence`）、自由入力の整形（`sanitizeChoiceText`）
- `jsonl-watcher.js` -- JSONL ファイルの監視。`attachExisting` モードで既存セッションにも接続可能
- `jsonl-utils.js` -- 共通ユーティリティ。`extractTextContent`, `extractToolUses`, `CLAUDE_PROJECTS_DIR` 等。jsonl-watcher.js と claude-sessions.js から参照
- `claude-sessions.js` -- Claude セッション一覧・履歴読み込み。`listRecentSessions()` はホーム下段用（mtime で直近 N 日を絞る）。「JSONL 文字列 → メッセージ配列」は `parseHistoryLines()` として切り出してあり、`loadSessionHistory()` とサブエージェントのトランスクリプト読み込みで共用する
- `subagent-tasks.js` -- サブエージェント（Agent ツール）の一覧 `listSubagentTasks()` とトランスクリプト読み込み `readSubagentTranscript()`。親 JSONL の走査はモジュール内キャッシュで前回オフセット以降だけ読み足す。agentId は `/^[A-Za-z0-9_-]+$/` で検証
- `session-summary.js` -- JSONL からカード用サマリ（タイトル・冒頭の依頼・直近のやりとり・cwd・ブランチ）を抽出。先頭 40 行＋末尾 128KB のみ読み、mtime でキャッシュ
- `storage.js` -- `~/.claude-bridge/` への永続化。`appendInbox()` で agent への送信を inbox に書き込む
- `claude-agents.js` -- `claude agents --json` から agent view のセッション一覧を取得
- `running-sessions.js` -- ホーム画面用。`~/.claude/sessions/*.json`（pid/sessionId/cwd/name/status/tmux）を読み、`ps` の生存 PID で絞って「今起動中の Claude セッション」を返す。`tmux` フィールドの paneId は `%<数字>` 形式のみ採用
- `thread-store.js` -- スレッド CRUD
- `rate-limits.js` -- Claude のレート制限（5h/7d ウィンドウの使用率）取得。**credentials・外部通信は使わない**。Claude Code が statusLine コマンドの stdin に渡す `rate_limits`（`used_percentage` / epoch 秒の `resets_at`）を `scripts/statusline/bridge-statusline-tee.js` がファイル（`<dataDir>/rate-limits.json`）に横流しし、`readRateLimits()` はそれを読むだけ。ローカルファイル読みなので `index.js` は 15 秒間隔でポーリングし、内容が変わったときだけ `rate_limits {usage, fetchedAt}` をブロードキャスト（`fetchedAt` は tee が書いた取得時刻で、statusline 連携が止まっていれば古いまま＝クライアント側の stale 判定に使われる）。statusline 未連携（ファイル無し）は `no-file` として一度だけ案内ログを出す

### statusLine tee（レート制限表示のデータ源）

`scripts/statusline/bridge-statusline-tee.js` を `~/.claude/settings.json` の `statusLine.command` に割り込ませ（`npm run setup:statusline`）、stdin で渡ってくる JSON のうち `rate_limits` だけを `<dataDir>/rate-limits.json` に `{ rate_limits, ts }` としてアトミック書き込み（tmp + rename）した上で、元々登録されていた statusLine コマンドへ stdin をそのまま引き継ぐ（表示は一切変えない）。tee 部分の失敗（parse 不能・書き込み失敗）で元コマンドの実行を止めない。依存なし（node 組み込みのみ）で statusLine の呼び出し頻度に耐える軽さを保つ。`scripts/setup-statusline.js` は元の `statusLine.command` を `<dataDir>/statusline-original.json` に退避してから差し替え、`--uninstall` で退避内容に戻す（再実行時はラッパー自身を original として保存しない）。

### クライアントのコンポーネント構成

- `App.jsx` -- 状態管理の中心。`sessionsRef` で sessions の最新値を参照（stale closure 対策）
- `ChatView.jsx` -- highlight.js は静的 import で13言語を登録。`EditDiff` は全文ハイライト後に行分割
- `ThreadPanel.jsx` -- リサイズハンドルは `widthRef` で useCallback の依存を空に
- `HomeView.jsx` -- ホーム画面（起動中セッション＋直近セッション）。`utils/runningSessions.js` の純粋関数で突合・整形
- `RateLimitMeter.jsx` -- ヘッダー右側の 5h/7d レート制限メーター。`rate_limits` メッセージを表示するだけの純表示コンポーネント（データが無ければ非表示）。バー色は使用率で `--success` / `--warning` / `--accent`、ツールチップにリセット時刻・残り時間・モデル別 weekly・取得時刻。`fetchedAt` が 10 分より古い（statusline 連携が止まっている＝セッション非稼働の疑い）と `stale` クラスで薄く表示し、ツールチップにも注記する（60 秒間隔の内部 tick で再判定するだけで、データ自体はサーバー push 任せ）
- `ChoicePrompt.jsx` -- 選択肢プロンプトのカード（入力欄の直上）。選択肢ボタン＝キー送信で、状態は毎回サーバーが読み直した画面から来る（クライアントは選択状態を持たない）
- `TaskStrip.jsx` -- サブエージェントタスクのチップ列（入力欄の直上、選択肢カードの上）。実行中は `⚙`、完了は `✓`。完了は 3 件を超えたら「✓ 他 N 件」に畳む
- `SubagentDrawer.jsx` -- サブエージェントの会話を見せる右サイドドロワー。本文は `ChatView.jsx` の `ChatMessage`（export 済み）を `readonly` で再利用する

### サブエージェントタスクの一覧とトランスクリプト

セッションが起動したサブエージェント（Agent ツール）を入力欄直上のチップで並べ、クリックで右サイドのドロワーに会話を出す。

- **データ源は `~/.claude/projects/<projectDir>/<claudeSessionId>/subagents/`**。`agent-<agentId>.meta.json`（`{agentType, description, toolUseId, spawnDepth}`）が一覧、`agent-<agentId>.jsonl` が会話（通常セッションと同じ形式・`isSidechain: true`）。ファイルを読むだけなので **readonly セッションでも動く**（PTY 不要）
- **完了判定は親 JSONL の tool_result**。サブエージェントが終わると親（`<claudeSessionId>.jsonl`）に meta の `toolUseId` を `tool_use_id` として持つ tool_result が書かれる。あれば `completed`、無ければ `running`。親 JSONL は数十 MB になり得るので `Map<jsonlPath, {offset, ids}>` に溜め、**追記分（前回オフセット以降）だけ読み足す**（末尾の書きかけ行は最後の改行までで打ち切る）。`toolUseId` を持たない古い meta は判定できないので completed 扱い
- WS メッセージ: `list_subagent_tasks {sessionId}` → `subagent_tasks {tasks}` / `get_subagent_transcript {sessionId, agentId}` → `subagent_transcript {agentId, status, messages}`。読み先（`projectDir` / `claudeSessionId`）は `resolveClaudeTarget()` が readonly セッション自身か `jsonlWatcher.getSessionMeta()` から解決する（解決できなければ `tasks: []`）
- 一覧は作業中タブを見ている間だけ 5 秒間隔でポーリング（ホーム表示中は止める）。ドロワーは開いている agent が `running` の間だけ 4 秒間隔で会話を取り直し、タブ切替・ホーム表示で閉じる

### ホーム画面（起動中セッション＋直近セッション）

タブの左端の「⌂ Home」で開く既定画面。上段に「今このマシンで起動している Claude セッション」、下段に「直近 N 日に動いていた（起動していない）セッション」を並べ、ブリッジのタブとして開いているものを区別する。

- 上段のデータ源は `list_running_sessions` → `running_sessions`（`server/running-sessions.js`）。ブリッジのタブ（`session_list`）とは独立した情報で、突合はクライアントの `utils/runningSessions.js`（`annotateRunningSessions` / `findOpenTab`）が行う
- 突合キーは `claudeSessionId` 優先、無ければ `claudePid`（tmux タブは JSONL 未解決でも pid は分かる）。死んだタブは「開いている」と扱わない
- 開いているセッションには「タブで表示中」バッジ＋左の色帯が付き、クリックでそのタブへ移動。未オープンは tmux ペインがあれば `attach_tmux_pane`、無ければ `open_readonly_session`（閲覧）で開く
- 下段のデータ源は `list_recent_sessions {days}` → `recent_sessions`（`claude-sessions.js` の `listRecentSessions`）。`~/.claude/projects/**/*.jsonl` の mtime で絞る。起動中のものは `annotateRecentSessions` が除外するので上下段は重複しない。カードのクリック＝閲覧（`open_readonly_session`）
- **下段の起こし方は 2 つ**（用途が違うので両方残している）
  - **「tmux で再開」＝ `resume_in_tmux`（既定・primary）**: `resumeInTmuxWindow()`（`server/tmux-session.js`）が **直近アタッチされた tmux セッションに新しい window を作り**（`tmux list-sessions` の `session_last_attached` 最大＝`pickTargetSession()`）、シェルを起こしてから `send-keys` で `claude --resume <id>` を流す。作成後は `attachTmuxPaneAsSession()`（`server/index.js` の共通ヘルパー。`attach_tmux_pane` と共用）で tmux タブとして開き、JSONL 監視＋履歴読み込みまで行う。tmux サーバーが動いていない場合だけ `bridge` セッションを `new-session -d` で作り、その初期 window をそのまま使う（空 window を残さない）。claude の pid は起動直後には分からないので `claudePid: null` で開き、サーバーの `statusInterval` が `mapPaneIdsToPids()`（`server/running-sessions.js`。ステータスファイルの `tmux` フィールドの paneId 突合）でバックフィルする
  - **「再開（内蔵）」＝ `resume_session`**: node-pty でブリッジの子プロセスとして `claude --resume` を起動する従来モード。ブリッジを落とすと claude も死に、ターミナルからは触れず、シェルの rc を通らないので env が違う。手軽さ用に残してあるが既定にはしない
  - 失敗時は `home_error` を返し、HomeView 上部の `.home-error` バナーで見せる（チャット欄の `error` はホーム表示中に見えないため別経路）。tmux 未インストールはコマンド全文ではなく短文にする
  - シェルに渡す値の検証: `claudeSessionId` は `/^[\w-]+$/`、tmux セッション名は `validateSessionName()` 相当の `/^[\w.:-]+$/`、生成された paneId は `validatePaneId()`（`%<数字>`）、cwd と window 名は `escapeForShell()`
- 期間は 1/3/7/30 日のプリセット（既定 7 日、localStorage `homeRecentDays`）。サーバー側は `clampDays()` で 1〜365 に丸める
- **Star（未解決／続きをやる印）**: カード右上の ☆/★ で付け外し。`utils/starredSessions.js` の純粋関数＋localStorage `homeStarredSessions`（claudeSessionId の配列）だけで管理し、サーバーには保存しない。Star 付きは上下段それぞれで先頭に並び（`sortStarredFirst`）、カード上辺に金色のライン、ヘッダに `★ N`。**Star 付きは期間外・limit 超過でも下段に必ず出す**（`list_recent_sessions` に `starred` を添え、`listRecentSessions({ includeSessionIds })` が期間フィルタと limit の外で拾う。サーバーは `sanitizeSessionIds()` で `/^[\w-]+$/`・200 件に制限）。star の付け外しでは一覧を取り直さない（JSONL 全走査を避けるため `starredRef` で送信時の値だけ使う）
- カードには JSONL から抜いたタイトル（`ai-title`）・冒頭の依頼・直近のユーザー指示・直近の応答・git ブランチを出す（`server/session-summary.js`）。先頭 40 行と末尾 128KB だけ読み、mtime でキャッシュするのでポーリングしても読み直さない
- `cwd` は projectDir 名から復元するとディレクトリ名のハイフンが壊れる（`claude-bridge` → `claude/bridge`）ため、JSONL に書かれた `cwd` を優先する。resume の起動先になるので重要
- どちらの一覧にも紐づかないタブ（期間外のセッションを閲覧で開いた・終了したタブ）は最下段の「その他の開いているタブ」に出す
- ホーム表示は `showHome` state（localStorage 記憶）。`activeSessionId` は保持したまま切り替えるため Home ⇄ 作業中タブを往復できる。起動中一覧はホーム表示中のみ 5 秒間隔でポーリングし、直近一覧はホームを開いた時・日数変更時・「更新」時だけ取得する（JSONL 全走査のため）

### 選択肢プロンプト（AskUserQuestion / ツール許可 / trust 確認）への回答

TUI に出る「番号つきの選択肢」をブラウザから選べるようにする仕組み。入力欄の直上に `ChoicePrompt` のカードを出し、ボタンのクリックを**キー入力として PTY / tmux ペインへ送る**。

- **待ちの検知は `~/.claude/sessions/<pid>.json` の `status:"waiting"` + `waitingFor`**（`"input needed"` = AskUserQuestion 等、`"permission prompt"` = ツール許可）。`claude-session-meta.js` の `readStatusByPid()` が `{status, waitingFor}` を返し、4 秒間隔の `statusInterval`（`index.js`）が両 manager の `refreshStatuses()` と `pollChoicePrompts()` を回す。`claudePid` が未解決な tmux セッション（`resume_in_tmux` 直後など）は `TmuxSessionManager.refreshStatuses()` が `mapPaneIdsToPids()` で paneId 突合してからバックフィルする（これが無いと該当タブでは選択肢プロンプトが永久に検知されない）
- **選択肢の中身は JSONL から取れない。** AskUserQuestion の `tool_use` が JSONL に書かれるのは**回答が終わったあと**（記録される `timestamp` は生成時刻なので、ファイルを見ると回答前から在ったように見えるが、待っている間はまだ書かれていない）。したがって情報源は画面テキストだけで、`parseChoicePrompt()`（`server/choice-prompt.js`）が構造化する
  - 画面の取得元: tmux は `capturePane()`、内蔵 PTY は `@xterm/headless` で ANSI を再現した `Session.getScreenText()`
  - **readonly セッションは対象外**（PTY が無く、inbox は Stop hook 経由なので選択待ち中は届かない）
- **キー操作は実測（Claude Code v2.1.233）に依存する**
  - 単一選択: **数字キー1つで即確定**（Enter は不要）
  - 複数選択（multiSelect）: 数字キーは**トグル**、Enter もカーソル位置のトグル。確定は **Tab → 確認画面の「1. Submit answers」**
  - 自由入力（"Type something"）: **番号キー → テキスト（リテラル） → Enter**。番号キーだけでは確定せず入力欄になる
  - キャンセル: Escape。複数質問は Tab / Shift+Tab でタブ移動
- **画面フォーマットの差**（パーサが吸収している）
  - AskUserQuestion は選択肢の上に `☐ 見出し`（複数選択・複数質問では `←  ☒ 見出し  ✔ Submit  →`）のタブ行が出る。multiSelect は各選択肢が `[ ]` / `[✔]`
  - permission プロンプトのフッターは `Esc to cancel · Tab to amend` で **`Enter to select` 行が無い**。上に diff（`╌` の破線）が出る
  - Tab 後の確認画面（`Ready to submit your answers?`）には**フッター行が一切出ない**。そのため「フッター or `❯` カーソル or タブ行のどれかがある」を検出条件にしている
- WS メッセージ: `get_choice_prompt {sessionId}` / `answer_choice_prompt {sessionId, keys, text}` → `choice_prompt {prompt, waitingFor}` / `choice_prompt_error`。`prompt: null` が「待っていない」の意味
- **画面を読むのは待ち状態のときだけ**（`get_choice_prompt` も `refreshSessionStatus()` してから読む）。入力欄に番号付きリストを書いている最中を選択肢と誤認しないため
- 送信後は `SCREEN_SETTLE_MS` 待って読み直して配る（次の質問・確認画面へ進んでいることがある）。同じ内容は `lastChoicePrompts` で抑止する

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
- 選択肢プロンプトへ送るキーは `choice-keys.js` のホワイトリストのみ（数字1桁と `Enter` / `Escape` / `Tab` / `BTab` / `Space` / 矢印）。tmux では数字を `-l` でリテラル送信し、それ以外はキー名として渡す
- 自由入力のテキストは `sanitizeChoiceText()` で改行を空白に潰して 2000 文字に切る（改行がそのまま届くと Enter＝確定として解釈されるため）。tmux へはさらに `escapeForShell()` を通す
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
