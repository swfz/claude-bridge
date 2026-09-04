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
npm run test:e2e     # Playwright による E2E スモークテスト（ビルド→fixture サーバーで実行）
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
- `shell-tasks.js` -- 実行中／終了済みの Bash 出力の一覧 `listShellTasks()` と本文読み込み `readShellTaskOutput()`。**データ源は Claude Code が Bash の出力をライブで書く `<os.tmpdir()>/claude-<uid>/<projectDir>/<claudeSessionId>/tasks/<taskId>.output`**（起点は `SHELL_TASKS_ROOT`。E2E 用に `CLAUDE_BRIDGE_SHELL_TASKS_ROOT` で差し替えられる）。**前景の Bash は実行中だけファイルが在り終了で消える／バックグラウンドは終了時に `[exited with code N]` のフッター行が付いて残る**ので、フッターの有無が `running` / `exited` の判定になる（判定と preview は末尾 4KB しか読まない）。ラベル（どの Bash か）は親 JSONL から拾う最善努力で、バックグラウンドは Bash の tool_result の冒頭の定型文 `Command running in background with ID: <taskId>` から taskId → tool_use を一意に引ける（出力先パスの文字列で判定すると、後続の別ツールの結果が同じパスを含んだときに上書きされてラベルが消える。最初の対応だけを信じる）が、**前景はファイルと tool_use を結ぶ手がかりが無いので「まだ tool_result の無い Bash」を出現順に、running のファイルを開始時刻順に並べて対応づける**（並列実行ではズレ得る）。親 JSONL の走査は subagent-tasks.js と同じくモジュール内キャッシュで前回オフセット以降だけ読み足す（`clearShellTasksCache()` で破棄）。taskId は `/^[A-Za-z0-9_-]+$/` で検証
- `session-summary.js` -- JSONL からカード用サマリ（タイトル・冒頭の依頼・直近のやりとり・cwd・ブランチ）を抽出。先頭 40 行＋末尾 128KB のみ読み、mtime でキャッシュ。公開した Artifact の一覧（`artifacts`）だけは head/tail に収まらないので `session-artifacts.js` に委譲する
- `session-artifacts.js` -- ホームのカード／行に出す「そのセッションで公開した Artifact」の生リスト `readSessionArtifacts(filePath, fileStat?)` → `[{url, title, path, timestamp}]`（出現順・重複排除なし）。publish のレコードは JSONL のどこにでも現れるので全文を見るしかないが、起動中一覧はホーム表示中 5 秒間隔でポーリングし JSONL は数十 MB になり得るので、**前回オフセット以降だけを読み足す**（`Map<filePath, {mtimeMs, size, offset, artifacts}>`。stat が前回と同じならキャッシュ返し、縮んでいたら先頭から読み直す）。オフセットはバイト数なのでストリームは encoding を付けず Buffer で受け、`indexOf(0x0a)` で切ってから `toString('utf-8')` する（末尾の書きかけ行は取り込まない）。JSON.parse の前に `line.includes('"toolUseResult"') && line.includes('claude.ai')` の安価なプリフィルタを通す。判定自体は `jsonl-utils.js` の `extractArtifactPublish()` と共通
- `storage.js` -- `~/.claude-bridge/` への永続化。`appendInbox()` で agent への送信を inbox に書き込む
- `claude-agents.js` -- `claude agents --json` から agent view のセッション一覧を取得
- `running-sessions.js` -- ホーム画面用。`~/.claude/sessions/*.json`（pid/sessionId/cwd/name/status/tmux）を読み、`ps` の生存 PID で絞って「今起動中の Claude セッション」を返す。`tmux` フィールドの paneId は `%<数字>` 形式のみ採用
- `activity-heatmap.js` -- ホーム画面の活動ヒートマップ（草）。`~/.claude/projects/**/*.jsonl` を全部読み、**ローカル日付**で「ユーザーの実プロンプト数 / assistant の応答数 / トークン（input・output・cache_creation・cache_read）」を日別に足す。サブエージェントの `subagents/agent-*.jsonl` も対象（本体側には書かれないので二重計上にはならない）。tool_result の user レコードは人が打ったものではないので数えない。全走査は 900MB 弱／9 秒かかるので、**ファイル単位の日別集計を `<dataDir>/activity-heatmap.json` に永続化**し、2 回目以降は追記分（前回オフセット以降）だけ読み足す（末尾の書きかけ行は最後の改行までで打ち切る／ファイルが縮んでいたら先頭から読み直す）。同じ走査が並行しないよう in-flight の Promise を共有する
- `thread-store.js` -- スレッド CRUD
- `slash-commands.js` -- 入力欄のスラッシュコマンド補完の候補を集める `listSlashCommands({cwd, claudeDir})`。プロセス起動はせず、スキル/コマンドのファイルを走査するだけ（`<claudeDir>/skills/*/SKILL.md`、`<claudeDir>/commands/**/*.md`、`cwd` 側の `.claude/` 配下、`plugins/installed_plugins.json` の `installPath` 配下、組み込みコマンドの静的配列）。スキルのディレクトリはシンボリックリンクが多いので `lstat` ではなく `stat` で追従する。**本体同梱スキル（`/code-review` `/simplify` `/loop` 等）は単一 ELF バイナリに埋め込まれていて走査も列挙サブコマンドも無いため、`BUNDLED_SKILLS` の静的リストで持つ既知の妥協**（本体更新で増減し得る）。description は frontmatter の `description:`（無ければ本文の最初の非空行）を 120 文字に切る。name の重複は project > user > plugin > bundled > builtin で先勝ち。走査が重いので `cwd`+`claudeDir` 単位で 30 秒キャッシュ（`clearSlashCommandsCache()` で破棄）。**`BUILTIN_COMMANDS` は「ブラウザから使える」と実測できた 4 件だけ**（`clear` / `compact` / `context` / `init`）。TUI 内にモーダルを開くもの（`/model` 等）は見えず操作もできないので出さない（詳細は「スラッシュコマンド補完」の節）
- `rate-limits.js` -- Claude のレート制限（5h/7d ウィンドウの使用率）取得。**credentials・外部通信は使わない**。Claude Code が statusLine コマンドの stdin に渡す `rate_limits`（`used_percentage` / epoch 秒の `resets_at`）を `scripts/statusline/bridge-statusline-tee.js` がファイル（`<dataDir>/rate-limits.json`）に横流しし、`readRateLimits()` はそれを読むだけ。ローカルファイル読みなので `index.js` は 15 秒間隔でポーリングし、内容が変わったときだけ `rate_limits {usage, fetchedAt}` をブロードキャスト（`fetchedAt` は tee が書いた取得時刻で、statusline 連携が止まっていれば古いまま＝クライアント側の stale 判定に使われる）。statusline 未連携（ファイル無し）は `no-file` として一度だけ案内ログを出す

### statusLine tee（レート制限表示のデータ源）

`scripts/statusline/bridge-statusline-tee.js` を `~/.claude/settings.json` の `statusLine.command` に割り込ませ（`npm run setup:statusline`）、stdin で渡ってくる JSON のうち `rate_limits` だけを `<dataDir>/rate-limits.json` に `{ rate_limits, ts }` としてアトミック書き込み（tmp + rename）した上で、元々登録されていた statusLine コマンドへ stdin をそのまま引き継ぐ（表示は一切変えない）。tee 部分の失敗（parse 不能・書き込み失敗）で元コマンドの実行を止めない。依存なし（node 組み込みのみ）で statusLine の呼び出し頻度に耐える軽さを保つ。`scripts/setup-statusline.js` は元の `statusLine.command` を `<dataDir>/statusline-original.json` に退避してから差し替え、`--uninstall` で退避内容に戻す（再実行時はラッパー自身を original として保存しない）。

### クライアントのコンポーネント構成

- `App.jsx` -- 状態管理の中心。`sessionsRef` で sessions の最新値を参照（stale closure 対策）
- `ChatView.jsx` -- highlight.js は静的 import で13言語を登録。`EditDiff` は全文ハイライト後に行分割。**react-markdown に渡す `components` / `remarkPlugins` / `urlTransform` はモジュール定数**（`MARKDOWN_COMPONENTS` 等）にし、ハンドラ（`sessionCwd` / `onOpenPreview` / `onOpenFileReview`）は `MarkdownHandlersContext` で渡す。inline で作り直すと React には別のコンポーネント型に見え、5 秒ごとのポーリング（`subagent_tasks`）で App が再描画されるたびに本文中の code / a 要素が全部再マウントされて `FilePreview` がチラつく（実測: 572 メッセージの閲覧タブで 22 秒に DOM 変更 2,460 件・50ms の long task が 5 秒ごと → 修正後 0）。同じ理由で `ChatMessage` は `memo` 化してあり、App 側から渡す props は useCallback / state の参照を保つこと（inline arrow を渡すと memo が無効になる）。**新着への自動スクロールは「最下部付近にいる間だけ」**（`hooks/useStickToBottom.js`）。上にスクロールして過去を読んでいる最中は位置を動かさず、代わりに `.scroll-to-latest`（「↓ 新しいメッセージ」）を sticky で出して押されたら末尾へ戻す。追従の再開判定は `utils/scroll.js` の `isScrolledToBottom()`（余白 80px）。タブ切替（`sessionId` = resetKey の変化）では追従状態に戻す
- `ThreadPanel.jsx` -- リサイズハンドルは `widthRef` で useCallback の依存を空に
- `SessionTabs.jsx` -- 左サイドバーのタブリスト。**Star（★）とセンシティブ指定（🔒）は表示専用**で、付け外しはホーム側だけ（キーはホームと同じ `claudeSessionId`）。折りたたみ時は状態ドットが右上なので印は左下に重ね、下地（`background: inherit`）を敷いて頭文字と重なっても読めるようにする
- `hooks/useGlobalKeys.js` -- 画面全体で効くキー（半画面スクロール・タブ移動）。App で 1 回だけ呼ぶ
- `ShortcutHints.jsx` -- サイドバー最下部の「今使えるキー操作」カンペ。状態は DOM の目印から判定する（詳細は「レビューのキーボード操作（ピックモード）」の節）
- `FileExplorer.jsx` -- ファイラ。**ルート（起点）は cwd 固定ではなく切り替えられる**（`cwd` / `~/tmp` / `~` / `/tmp` / 手入力の履歴）。候補と `~` 展開に必要な home は `/roots` から取り、クライアントは絶対パスだけを扱う（表示ラベルだけ `~` に畳む）。ロジックは `utils/filerRoots.js` の純粋関数、選択と手入力履歴は localStorage（`filerRoot` / `filerCustomRoots`）。ツリーも `/search` も選択中のルート配下。**どこまで開けるかを決めているのはサーバー側のサンドボックス（home か `/tmp` 配下のみ）**なので、ルートを増やしてもクライアント側に権限判断は持たせない
- `HomeView.jsx` -- ホーム画面（起動中セッション＋直近セッション）。`utils/runningSessions.js` の純粋関数で突合・整形
- `HomeArtifactChips.jsx` -- ホームのカード／行に出す Artifact リンクのチップ列。`artifacts`（publish の生リスト）を `groupArtifactPublishes()` で URL ごとにまとめ、既定 3 件＋溢れは `+N`。`compact` は行用で、タイトルは先頭のチップだけに出して残りはアイコンにし列幅（160px）に収める。**チップの `onClick` で伝播を止める**（止めないとカード／行のクリックでセッションが開く）
- `RateLimitMeter.jsx` -- ヘッダー右側の 5h/7d レート制限メーター。`rate_limits` メッセージを表示するだけの純表示コンポーネント（データが無ければ非表示）。バー色は使用率で `--success` / `--warning` / `--accent`、ツールチップにリセット時刻・残り時間・モデル別 weekly・取得時刻。`fetchedAt` が 10 分より古い（statusline 連携が止まっている＝セッション非稼働の疑い）と `stale` クラスで薄く表示し、ツールチップにも注記する（60 秒間隔の内部 tick で再判定するだけで、データ自体はサーバー push 任せ）
- `ActivityPanel.jsx` -- ホーム最上段の活動パネル。`activity_heatmap`（365 日分）を描くだけの純表示コンポーネントで、集計・整形は `utils/heatmap.js` の純粋関数が持つ。**同じデータを 3 ビューで見せる**（`HeatmapView` / `DailyView` / `WeekdayView` の小コンポーネントを 1 ファイルに同居）。ビュー・メトリック（メッセージ / トークン）・開閉は localStorage（`homeActivityView` / `homeHeatmapMetric` / `homeHeatmapOpen`）に覚える
  - **草**: 1 列 = 1 週（GitHub と同じ日曜始まり）。**濃淡のしきい値は固定値ではなく「活動があった日」の分位（p25/p50/p75）**。日によって桁が違う（トークンは特に）ため。色は `--heat-0`〜`--heat-4`（ライト/ダークで別値）
  - **日別**: 1 本 = 1 日の縦棒。濃淡では潰れる量の差を高さで読むビューなので、**分位ではなく最大値に対する線形**にする（草と役割を分ける）。棒と月の目盛りは同じ `grid-template-columns: repeat(var(--count), var(--bar))` を共有するので必ず日と揃う
  - **曜日**: 月曜始まりの横棒 7 本（草だけが日曜始まりなのは GitHub に合わせているため）。合計値と「その曜日で活動があった日数」を添える
  - 草と日別は横に長いのでこのブロックだけ横スクロールし、初期位置は右端（最新）。**左端の曜日ラベル／y 軸目盛りは `position: sticky; left: 0` で貼り付ける**（スクロールすると流れて消えるため。背景色を敷かないと升目が透ける）
- `InputBar.jsx` -- 送信欄。書きかけは `key={draftKey}` の remount をまたぐようモジュールレベルの `drafts` Map に置く。**スラッシュコマンド補完**は `slashCommands` prop の候補を入力欄の直上にドロップダウンで出す。表示条件は `text` が `/^\/[A-Za-z0-9_:-]*$/`（先頭 `/` の 1 トークン目を打っている間）で、前方一致が 0 件なら部分一致にフォールバックし 50 件で打ち切る。表示中は ArrowUp/Down で選択、Tab/Enter で `/name ` に確定（**Enter は送信しない**）、Escape で畳む（次の入力で復帰）。`onSendEscape` が渡されたときだけ送信ボタンの左に `Esc` ボタンを出す（TUI で開いてしまったモーダルを閉じる用。**補完を畳む Escape キー操作とは別物**）
- `ChoicePrompt.jsx` -- 選択肢プロンプトのカード（入力欄の直上）。選択肢ボタン＝キー送信で、状態は毎回サーバーが読み直した画面から来る（クライアントは選択状態を持たない）
- `TaskStrip.jsx` -- サブエージェントタスクと実行中シェルのチップ列（入力欄の直上、選択肢カードの上）。サブエージェントは実行中が `⚙`・完了が `✓`、シェルはその後ろに並べて実行中が `$`・終了は exit code 0 なら `✓`、それ以外は `✗`（`task-chip-failed`）。**終了済みは種別を混ぜて 1 つの折りたたみにまとめ**、3 件を超えたら「✓ 他 N 件」に畳む
- `ArtifactStrip.jsx` -- そのセッションで `Artifact` ツールが公開した claude.ai のページ（アーティファクト）のリンク一覧。チャット最上部に sticky で貼り付け、URL ごとに 1 チップ（再デプロイは `×N`）。**データ源は JSONL の user レコードの `toolUseResult`**（publish 成功時だけ `{url, path, title}` を持つオブジェクト。失敗時は文字列＋`is_error`、`read`/`list` は `url` を持たない）。`jsonl-utils.js` の `extractArtifactPublish()` が判定し、`parseHistoryLines()` と `JsonlWatcher` が `role: 'artifact'` のメッセージ（`url`/`title`/`path`）として本文と同じ列に流す。`ChatMessage` はこの role を「🔗 Artifact を公開 <リンク>」の 1 行カードで描き、一覧は `utils/artifacts.js` の `collectArtifacts()`（URL で重複排除・最終 publish が先頭）が messages から作る。**`.chat-message` は `<div key>` でラップされていて flex item ではない**ので中央寄せは `align-self` ではなく `width: fit-content; margin: 0 auto`（既存の `.chat-message.system` の `align-self` は効いていない）。**ホーム画面のカード／行にも同じリンクを出す**（`HomeArtifactChips.jsx`）。こちらのデータ源はチャットのメッセージ列ではなく summary の `artifacts`（`server/session-artifacts.js`）で、URL ごとのまとめは `utils/artifacts.js` から切り出した `groupArtifactPublishes()` を共用する
- `SubagentDrawer.jsx` -- サブエージェントの会話を見せる右サイドドロワー。本文は `ChatView.jsx` の `ChatMessage`（export 済み）を `readonly` で再利用する。スクロール追従も `useStickToBottom`（resetKey は `agentId`）で ChatView と同じ挙動
- `ShellOutputDrawer.jsx` -- Bash の出力を見せる右サイドドロワー。`SubagentDrawer` と同じ構造だが本文はプレーンテキストなので `<pre class="shell-output-text">`（等幅・`pre-wrap`・`overflow-wrap: anywhere`）にそのまま流す。ヘッダに taskId・状態（実行中 / 終了 code N）・末尾だけ返ってきたときの「先頭を省略」バッジ。スクロール追従は `useStickToBottom`（resetKey は `taskId`）。CSS は共通化せず `shell-drawer-*` として複製してある

### サブエージェントタスクの一覧とトランスクリプト

セッションが起動したサブエージェント（Agent ツール）を入力欄直上のチップで並べ、クリックで右サイドのドロワーに会話を出す。

- **データ源は `~/.claude/projects/<projectDir>/<claudeSessionId>/subagents/`**。`agent-<agentId>.meta.json`（`{agentType, description, toolUseId, spawnDepth}`）が一覧、`agent-<agentId>.jsonl` が会話（通常セッションと同じ形式・`isSidechain: true`）。ファイルを読むだけなので **readonly セッションでも動く**（PTY 不要）
- **完了判定は親 JSONL の tool_result**。サブエージェントが終わると親（`<claudeSessionId>.jsonl`）に meta の `toolUseId` を `tool_use_id` として持つ tool_result が書かれる。あれば `completed`、無ければ `running`。親 JSONL は数十 MB になり得るので `Map<jsonlPath, {offset, ids}>` に溜め、**追記分（前回オフセット以降）だけ読み足す**（末尾の書きかけ行は最後の改行までで打ち切る）。`toolUseId` を持たない古い meta は判定できないので completed 扱い
- WS メッセージ: `list_subagent_tasks {sessionId}` → `subagent_tasks {tasks}` / `get_subagent_transcript {sessionId, agentId}` → `subagent_transcript {agentId, status, messages}`。読み先（`projectDir` / `claudeSessionId`）は `resolveClaudeTarget()` が readonly セッション自身か `jsonlWatcher.getSessionMeta()` から解決する（解決できなければ `tasks: []`）
- 一覧は作業中タブを見ている間だけ 5 秒間隔でポーリング（ホーム表示中は止める）。ドロワーは開いている agent が `running` の間だけ 4 秒間隔で会話を取り直し、タブ切替・ホーム表示で閉じる

### 実行中シェルの出力

Claude Code の TUI で Bash 実行中に見えるライブ出力（バックグラウンドなら `/tasks` から辿れるもの）を、ブラウザからも同じチップ＋ドロワーで見せる。

- **データ源は `<os.tmpdir()>/claude-<uid>/<projectDir>/<claudeSessionId>/tasks/<taskId>.output`**（`server/shell-tasks.js`）。JSONL ではなくファイルを読むだけなので **readonly セッションでも動く**（PTY 不要）
- 前景の Bash は終了するとファイルごと消えるため、チップから消えるのが正常。バックグラウンドは `[exited with code N]` のフッター付きで残る
- WS メッセージ: `list_shell_tasks {sessionId}` → `shell_tasks {sessionId, tasks}` / `get_shell_task_output {sessionId, taskId}` → `shell_task_output {sessionId, taskId, status, exitCode, text, truncated, size}`。読み先は subagent と同じ `resolveClaudeTarget()`。読めなければ `text: ''` + `error`
- 一覧は作業中タブを見ている間だけ 3 秒間隔でポーリング（ホーム表示中は止める）。ドロワーは開いている taskId が `running` の間だけ 2 秒間隔で本文を取り直し、タブ切替・ホーム表示で閉じる
- 本文は末尾 256KB までで、超えたら `truncated`（先頭の壊れた行は捨てる）。ANSI エスケープ（CSI / OSC）は落とし、フッター行は `text` から外して状態バッジに回す
- ポーリングで届いた一覧は `App.jsx` の `keepIfUnchanged()` が内容比較して**同じなら前の参照を保つ**（毎回新しい配列を state に入れると App が再描画され、`ChatView` の memo が崩れて本文がチラつく）。`subagent_tasks` も同じ扱い

### スラッシュコマンド補完

TUI の補完はブラウザからは使えないので、入力欄でスキル名・コマンド名の候補をブリッジ自身が出す。

- 候補は `server/slash-commands.js` の `listSlashCommands()` がファイル走査で作る（`claude` コマンドは起動しない）。ユーザー/プロジェクト/プラグインのスキル・コマンドに、走査できない本体同梱スキル（`bundled`）と組み込みコマンド（`builtin`）の静的リストを混ぜ、`{name, description, source}` の name 昇順で返す
- WS メッセージ: `list_slash_commands {sessionId}` → `slash_commands {sessionId, commands}`。**cwd はクライアントから受け取らず** `findSession()` で解決したセッションの `cwd` だけを使う（任意パスを走査させないため）。セッションが見つからなくてもユーザー側の候補は返し、失敗時は `commands: []`
- 候補は cwd に依存するのでタブごとに 1 度だけ取る（`slashRequestedRef` で取得済みを覚える。サーバー側の 30 秒キャッシュがあるのでポーリングはしない）。PTY・tmux・readonly の全種別の `InputBar` に渡す
- **コマンドは 3 種類に分かれ、ブラウザから使えるのは 2 種類だけ**（Claude Code v2.1.238 の実測）。スキル系（`/commit` などプロンプトに展開されるもの）と、`/context` のように結果が会話に描画されるインライン実行型は普通に動く。一方 `/model` `/help` `/usage`（`/cost`）などの**モーダル型は TUI 内にパネルが開くだけで、`waitingFor` が立たないため選択肢カードも出ず、Raw ビューも出力専用でキーを送れない**＝ブラウザからは見えず操作もできない。よって `BUILTIN_COMMANDS` はモーダル型を外し `clear` / `compact` / `context` / `init` の 4 件だけにしてある（`todos` / `doctor` は組み込みコマンドとして実在しない）
- 手で打てばモーダル型も実行されてしまうので、復帰用に**入力欄の `Esc` ボタン**を置く（`InputBar` の `onSendEscape`。PTY のある側にだけ渡す）。新しい WS メッセージは作らず、`waitingFor` を要求しない `answer_choice_prompt` に `keys: ['Escape']` を流すだけ

### ホーム画面（起動中セッション＋直近セッション）

タブの左端の「⌂ Home」で開く既定画面。上段に「今このマシンで起動している Claude セッション」、下段に「直近 N 日に動いていた（起動していない）セッション」を並べ、ブリッジのタブとして開いているものを区別する。

- 上段のデータ源は `list_running_sessions` → `running_sessions`（`server/running-sessions.js`）。ブリッジのタブ（`session_list`）とは独立した情報で、突合はクライアントの `utils/runningSessions.js`（`annotateRunningSessions` / `findOpenTab`）が行う
- 突合キーは `claudeSessionId` 優先、無ければ `claudePid`（tmux タブは JSONL 未解決でも pid は分かる）。死んだタブは「開いている」と扱わない
- 開いているセッションには「タブで表示中」バッジ＋左の色帯が付き、クリックでそのタブへ移動。未オープンは tmux ペインがあれば `attach_tmux_pane`、無ければ `open_readonly_session`（閲覧）で開く
- 下段のデータ源は `list_recent_sessions {days}` → `recent_sessions`（`claude-sessions.js` の `listRecentSessions`）。`~/.claude/projects/**/*.jsonl` の mtime で絞る。起動中のものは `annotateRecentSessions` が除外するので上下段は重複しない。カードのクリック＝閲覧（`open_readonly_session`）
- **下段の起こし方は 2 つ**（用途が違うので両方残している）
  - **「tmux で再開」＝ `resume_in_tmux`（既定・primary）**: `resumeInTmuxWindow()`（`server/tmux-session.js`）が **直近アタッチされた tmux セッションに新しい window を作り**（`tmux list-sessions` の `session_last_attached` 最大＝`pickTargetSession()`）、シェルを起こしてから `claude --resume <id>` を流す。**送信は `sendCommandWhenShellReady()`**: rc（mise/nvm/p10k 等）の初期化が遅い環境では固定 delay だと入力が食われるため、本文だけ `-l` で送り、`capture-pane` でエコー（空白除去して比較＝折り返し対応）を確認してから Enter を送る。しばらくエコーが見えなければ `C-u` でクリアして再送、15 秒でタイムアウトエラー。作成後は `attachTmuxPaneAsSession()`（`server/index.js` の共通ヘルパー。`attach_tmux_pane` と共用）で tmux タブとして開き、JSONL 監視＋履歴読み込みまで行う。tmux サーバーが動いていない場合だけ `bridge` セッションを `new-session -d` で作り、その初期 window をそのまま使う（空 window を残さない）。claude の pid は起動直後には分からないので `claudePid: null` で開き、サーバーの `statusInterval` が `mapPaneIdsToPids()`（`server/running-sessions.js`。ステータスファイルの `tmux` フィールドの paneId 突合）でバックフィルする
  - **「再開（内蔵）」＝ `resume_session`**: node-pty でブリッジの子プロセスとして `claude --resume` を起動する従来モード。ブリッジを落とすと claude も死に、ターミナルからは触れず、シェルの rc を通らないので env が違う。手軽さ用に残してあるが既定にはしない
  - 失敗時は `home_error` を返し、HomeView 上部の `.home-error` バナーで見せる（チャット欄の `error` はホーム表示中に見えないため別経路）。tmux 未インストールはコマンド全文ではなく短文にする
  - シェルに渡す値の検証: `claudeSessionId` は `/^[\w-]+$/`、tmux セッション名は `validateSessionName()` 相当の `/^[\w.:-]+$/`、生成された paneId は `validatePaneId()`（`%<数字>`）、cwd と window 名は `escapeForShell()`
- 期間は 1/3/7/30 日のプリセット（既定 7 日、localStorage `homeRecentDays`）。サーバー側は `clampDays()` で 1〜365 に丸める
- **Star（未解決／続きをやる印）**: カード右上の ☆/★ で付け外し。`utils/starredSessions.js` の純粋関数＋localStorage `homeStarredSessions`（claudeSessionId の配列）だけで管理し、サーバーには保存しない。Star 付きは上下段それぞれで先頭に並び（`sortStarredFirst`）、カード上辺に金色のライン、ヘッダに `★ N`。**Star 付きは期間外・limit 超過でも下段に必ず出す**（`list_recent_sessions` に `starred` を添え、`listRecentSessions({ includeSessionIds })` が期間フィルタと limit の外で拾う。サーバーは `sanitizeSessionIds()` で `/^[\w-]+$/`・200 件に制限）。star の付け外しでは一覧を取り直さない（JSONL 全走査を避けるため `starredRef` で送信時の値だけ使う）
- カードには JSONL から抜いたタイトル（`ai-title`）・直近のユーザー指示（無ければ冒頭の依頼）・直近の応答・パス・git ブランチを出す（`server/session-summary.js`）。先頭 40 行と末尾 128KB だけ読み、mtime でキャッシュするのでポーリングしても読み直さない
- **公開した Artifact のリンク**も上下段に出す（`HomeArtifactChips.jsx`）。上段はカードのスニペットの下に「🔗 タイトル ×N」、下段は「応答」と「更新」の間の固定幅列にアイコンだけのチップ。下段はタイトル列に混ぜてはいけない（`.home-row-actions` がホバー時に `left: 65px` から重なって押せなくなる）ので右端寄りの独立した列にする。データは summary の `artifacts`（`server/session-artifacts.js` の差分走査）
- **カードの色は 2 系統だけ**（意味が混ざらないよう位置で役割を分ける）。左の縦帯（`.home-card::before` の `--rail`）＝ブリッジとの関係（`rail-active` 表示中=`--accent` / `rail-open` タブで開き済=`--accent-secondary` / それ以外=帯なし）、タイトル左のドット（`.home-status`）＝Claude プロセスの状態（busy=橙パルス / idle=緑）。背景の全面塗り・Star の上辺ライン・active の枠色は帯と競合するので使わない（Star は並び順と ★ の金色だけで示す）
- **上段はカード、下段は行リスト**（用途が違う）。上段（起動中・少数・状態を見比べる）は `.home-grid` のカード、下段（直近・多数・探す）は `.home-rows` の 1 行 1 セッション。行は全行同じ `grid-template-columns`（★／🔒／パス／タイトル／直近の指示／直近の応答／経過時間）で列位置が揃うので件数が増えても走査できる。やり取りを読ませる列に幅を寄せてタイトル列は狭く取り、指示列と応答列は細い罫線（`.home-row-snippet.assistant` の `border-left`）だけで区切る。列名は `.home-rows-header` が同じ `grid-template-columns` を共有して出し、スクロール中も見えるよう sticky で貼り付ける（**`.home-rows` の `overflow` は `hidden` ではなく `clip`**。`hidden` だとスクロールコンテナ扱いになって sticky が効かない。`top` は `.home-view` の `--home-pad-top` を打ち消す負値にする＝ padding box に貼ると直前の行が上から覗くため）。ヘッダーを薄くするのに `opacity` を使うと背景まで透けて下の行が見えるので、薄さは文字色と子要素側の `opacity` で作る
- **カードは 1 行 clamp × 固定構成**（パス行／タイトル／スニペット 2 行／メタ行）で、`.home-grid` の `grid-auto-rows: 1fr` と `.home-card-meta` の `margin-top: auto` で行ごとに高さを揃える。フルパス・pid・tmux ターゲット・サイズ・sessionId は `title` 属性へ逃がす。アクションボタンはカード下部／行の右端にホバーで重ねる（`@media (hover: none)` では常時表示）。全件に付くもの（`INTERACTIVE` / `未オープン` バッジ、`main` `master` `HEAD` のブランチ名）は識別に寄与しないので出さない
- `cwd` は projectDir 名から復元するとディレクトリ名のハイフンが壊れる（`claude-bridge` → `claude/bridge`）ため、JSONL に書かれた `cwd` を優先する。resume の起動先になるので重要
- どちらの一覧にも紐づかないタブ（期間外のセッションを閲覧で開いた・終了したタブ）は最下段の「その他の開いているタブ」に出す
- **最上段の活動パネル**: `list_activity_heatmap {days}` → `activity_heatmap {days, total, generatedAt}`（`server/activity-heatmap.js`）。直近 365 日を草 / 日別の棒 / 曜日別の 3 ビューで見せ、メッセージ数とトークン数を切り替えられる（ビューを変えてもサーバーには取りに行かない。3 つとも同じ 365 日分から計算する）。取得はホームを開いた時と「更新」時だけ（直近一覧と同じ理由）。**セッション一覧のどのセクションにも属さない全体の指標なので、見出しより前・画面の最上段に置く**。共有モードでもパスは出ないので隠していない
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
  - **レビュー＝送る（pending review）**: `ReviewDraftPanel` で指摘を溜める。`save_review`/`get_review` で下書きを `review-<key>.json` に永続化（リロード/再オープンしても残る）。「Submit」で `submit_review` を投げると、**サーバーが対象セッション種別で送信先を出し分ける**（`readonly` → `storage.appendInbox(claudeSessionId)` ＝inbox / それ以外（PTY あり）→ `session.write` ＝Claude へ）。送信本文は `[レビュー N件] ...`。Submit 成功で下書きはクリア。ファイルプレビュー（`PreviewDrawer` の `reviewMode` + `ReviewPanel`）のファイルレビューも同じ `submit_review` 経由（各項目にファイル名を前置）で、readonly でも届く。**プレビューの書きかけ項目はサーバーに保存せず、`InputBar` の drafts と同じくモジュールレベルの `reviewDrafts` Map（キーは `filePath`、Markdown プレビューは `md:<title>`）に置く**。ドロワーは閉じると `previewData` が null になってアンマウントされるので、これが無いと閉じた瞬間に消える。リロードで消えるのは書きかけとして許容。**キー操作は `ReviewDraftPanel` と共通**（判定は `utils/keys.js`）で、「書く → `Ctrl/Cmd+Enter` で確定して次の欄へ（溜める）→ … → `Ctrl/Cmd+Shift+Enter` で一括送信」の流れに合わせてある。プレビューでは `Ctrl+Enter` が「送る」項目なら**確定して本文へフォーカスを戻す**（続けて数字キーで次の行を選べる。「残す」項目なら保存）。選択なし（ファイル全体）の欄は本文で `Enter` を空押しするか送信ボタン左の「+ 指摘を追加」で作り（`addFreeItem`）、`selectedText: ''`・`location: null` で、表示は「（選択なし・ファイル全体への指摘）」、送信本文は `N. ファイル全体 について:` になる（`「」` の空引用を出さない）。何も書かずに確定した空の全体欄は捨てる。行の選び方は「レビューのキーボード操作（ピックモード）」の節を参照。**一括送信のキーは指摘欄にフォーカスが無くても効く**よう、指摘欄の `onKeyDown` に加えて document と HTML プレビューの `iframe.contentDocument` にも `keydown` を張る（mouseup と同じ理由。iframe 内にフォーカスがあると親には届かない。指摘欄側で処理済み＝`defaultPrevented` のものは二重送信しない）。`ReviewDraftPanel` 側も同じく document で拾うが、`.drawer-overlay` が開いている間はドロワーの送信を優先して無視する。`isEnterKey()` は `e.key` に加えて `e.code`（`Enter` / `NumpadEnter`）も見る（日本語 IME 経由で `key: 'Process'` になることがある。変換中 `isComposing` は除外）。
  - **コメント＝残す（参照専用）**: `save_comment`/`get_comments`/`delete_comment` ↔ `CommentPanel`（入力欄つき一覧）。`comments-<key>.json` に保存し**送信は一切しない**。セッションに対して残し、再オープン/resume/閲覧をまたいで参照できる。
  - メッセージ単位の Memo/Review ボタンや `CommentPopover`、`send_comment_to_claude` は廃止（`Thread` だけは別機能としてメッセージ単位で残存）。
  - **プレビュー上の選択コメント**: コード/テキスト/Markdown は drawer 本文（`bodyRef`）の `mouseup` で選択を拾う。**HTML は iframe に描画されるため親の選択 API では拾えない**ので、`iframe.contentDocument` に直接 `mouseup` を張る（`/preview` は同一オリジンで `sandbox="allow-scripts allow-same-origin"` なのでアクセスできる）。ポップアップ位置は iframe の矩形分オフセットして本文座標に変換する。行・列は HTML ソースを別途 `fetch` し、表示テキスト上の出現順（`getOccurrenceIndex`）と同じ出現をソース内で探して（`findOccurrenceOffset`）算出する（`buildLocationInfo` の `kind: "html"`）。iframe 内には 💬 ガターは出せないので、位置は保存された `anchor.line`／ラベルで示す
- **配信**（agent 側で受信）: claude-bridge 同梱フックを**グローバル** `~/.claude/settings.json` に登録（`npm run setup:hooks`）。
  - **turn 配信（Stop hook）に一本化**。応答終了ごとに発火し、inbox の未読をまとめて `{decision:"block", reason}` で注入する。対象が idle の場合は次の応答時に届く。常駐プロセス（monitor）は PID 再利用・サンドボックス・応答途中への割り込みで誤動作が多く廃止した
  - `scripts/hooks/bridge-check-inbox.js` -- Stop hook（turn 配信）の本体。応答終了時に未読を注入。`stop_hook_active` で無限ループ回避
- 既読位置は `inbox/<sessionId>.offset` で管理（サーバーは書くだけ、offset 更新はフック側）
- **claude-bridge の介入範囲（誤解防止）**: bridge が会話に作用するのは Stop hook（`bridge-check-inbox.js`）による**注入のみ**。注入文には必ず `[claude-bridge]` マーカーが付き、「UI 由来のユーザーメッセージでツール実行結果ではない」と明記される。注入の事実は `~/.claude-bridge/delivery.log`（JSONL: `ts`/`sessionId`/`count`/`texts`）に全文記録される。**Bash 等のツールの標準出力には一切介入しない（構造上できない）**。ツール出力の不整合を bridge のせいと疑う前に、まず `delivery.log` を確認すること（該当セッションの注入記録が無ければ bridge は無関係）
- テスト時は `CLAUDE_BRIDGE_DIR` 環境変数で inbox の位置を上書きできる

### レビューのキーボード操作（ピックモード）

レビューの流れ「対象を選ぶ → 指摘欄が開く → 書く → 確定 → …（繰り返し）→ 一括送信」を全部キーボードで回すための仕組み。対象は **プレビュー窓の行**（`PreviewDrawer`）と **チャットのメッセージ**（`ChatView`）の 2 種類で、状態遷移は共通。

| キー                                               | プレビュー窓（行）                                                                                                                                                                                                                                                                                                                                                                                                                            | チャット（メッセージ）                                                                     | 指摘欄（textarea 内）                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `0-9`                                              | 本文にフォーカスがあれば即ピック開始（行番号を打つ）                                                                                                                                                                                                                                                                                                                                                                                          | `Alt+R` の後だけ有効（番号を打つ。`.` の後は行番号）                                       | 通常入力                                                                                    |
| `Alt+R`                                            | ピック開始（入力欄からでも。blur してから）                                                                                                                                                                                                                                                                                                                                                                                                   | ピック開始（送信欄からでも）                                                               | 同左                                                                                        |
| `↑` / `↓`                                          | 行 ∓1                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 段目: 番号 ±1（上＝古い方＝番号が増える）／2 段目: 行 ∓1（反転しない）                   | -                                                                                           |
| `Alt+H/J/K/L`                                      | `← ↓ ↑ →` の代わり（`utils/keys.js` の `vimNavKey`）。入力欄にフォーカスがあっても効き、ピック中でなければ blur してピックを開始し、そのまま移動する。**未入力からの移動は方向に関わらず 1（最新／先頭）に着地**（上方向で末尾に飛ばされると戻る手間の方が大きい）                                                                                                                                                                            | 同左                                                                                       | 同左（欄から抜けてピックへ）                                                                |
| `.`                                                | -                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2 段目（メッセージ内の行）へ。対象を全文表示にし、各ブロックにソース行番号のバッジが出る   | -                                                                                           |
| `→` / `←`                                          | -                                                                                                                                                                                                                                                                                                                                                                                                                                             | 対象メッセージの全文表示／折りたたみ                                                       | -                                                                                           |
| `p` / `Tab`                                        | -                                                                                                                                                                                                                                                                                                                                                                                                                                             | 対象メッセージ内のファイルリンク（`.file-link`）をプレビュー／複数あれば `Tab` で巡回      | -                                                                                           |
| `Enter`                                            | 番号あり＝その行の指摘欄を開く／番号なし＝「ファイル全体」の欄                                                                                                                                                                                                                                                                                                                                                                                | 1 段目＝メッセージ全体を引用した欄／2 段目＝そのブロックを引用した欄を Review パネルに開く | 改行                                                                                        |
| `⌫`                                                | 1 桁戻す                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1 桁戻す（2 段目が空なら 1 段目へ）                                                        | 通常入力                                                                                    |
| `Esc`                                              | ピック中＝取消（ドロワーは閉じない）／それ以外＝閉じる                                                                                                                                                                                                                                                                                                                                                                                        | 取消                                                                                       | 確定して本文へ戻る（ドロワーは閉じない）                                                    |
| `Ctrl/Cmd+Enter`                                   | -                                                                                                                                                                                                                                                                                                                                                                                                                                             | -                                                                                          | 確定（プレビュー＝本文へフォーカスを戻す。空の全体欄は捨てる／Review パネル＝次の欄を追加） |
| `Ctrl/Cmd+Shift+Enter`                             | 一括送信（フォーカス位置を問わない）                                                                                                                                                                                                                                                                                                                                                                                                          | 同左（Review パネルが開いていれば）                                                        | 一括送信                                                                                    |
| `Ctrl/Cmd+Shift+⌫`（Delete）                       | -                                                                                                                                                                                                                                                                                                                                                                                                                                             | -                                                                                          | 今書いている指摘の欄ごと削除（プレビュー＝本文へ戻る／Review パネル＝直前の欄へ）           |
| `Ctrl+D` / `Ctrl+U`                                | **ピック中＝対象を半画面分先の行へ飛ばす**（`utils/pickJump.js` の `halfScreenJump`。番号ではなく要素の画面上の位置で決める。長いメッセージが混ざると「n 件先」では移動量がぶれるため）／ピック中でなければ半画面スクロール（`hooks/useGlobalKeys.js`。ドロワー → チャット → ホームの順で内側の本文。入力欄にフォーカスがあるときは素通し）。ブラウザのブックマーク／ソース表示と重なるが予約キーではないので `preventDefault` で横取りできる | 同左（1 段目＝メッセージ、2 段目＝行）                                                     | 素通し                                                                                      |
| `Alt+Shift+J` / `Alt+Shift+K`、`Alt+1〜9`、`Alt+0` | 次・前のセッションタブ／n 番目のタブ／ホーム（ホームを 0 番目として巡回。並びと絞り込みはサイドバーと同じ）。入力欄にフォーカスがあっても効く                                                                                                                                                                                                                                                                                                 | 同左                                                                                       | 同左                                                                                        |

- **状態遷移は純粋関数** `utils/numberPick.js`（`pickReducer` / `resolveTarget` / `keyToPickAction`。`test/number-pick.test.js`）。DOM への取り付けは `hooks/useNumberPick.js` で、document と `extraDocs`（HTML プレビューの `iframe.contentDocument`。差し替わるので毎レンダー貼り直す）に keydown を張る。`allowBareDigits`（数字キー単独で開始してよいか）はプレビューだけ真。**チャットで `Alt+R` を必須にしているのは、送信欄からフォーカスが外れた時に打った数字を誤って拾わないため**。`Alt+R` の判定（`utils/keys.js` の `isPickModeShortcut`）は Ctrl/Cmd 系だとブラウザのショートカットと衝突しやすいので Alt にしてあり、レイアウトで `e.key` が別文字になっても拾えるよう `e.code === 'KeyR'` も見る
- **プレビューの行の特定**: コード/テキストは `pre.drawer-text` の中を **1 行 1 要素**（`<span class="drawer-code-line" data-line="N">`）にする（`utils/codeLines.js` の `buildCodeLinesHtml`。hljs の span が複数行にまたがるので `splitHighlightedLines` が行末で閉じて次行で開き直す）。**行の区切りは実際の `\n` テキストのまま、行番号は `::before { content: attr(data-line) }` で描く**。`pre` の textContent がソースと一致していないと、選択範囲から行・列を出す `computeLocation` / `handleMouseUp` が壊れるため。💬 マーカー位置もこの行要素の矩形から取る（以前の行高×行数だと折り返し行でズレた）。Markdown は表示に行が出ないので、`[data-source-line]` を持つ末端ブロック（`LEAF_BLOCKS`）ごとにソース行番号のバッジ `.line-pick-badge` を左ガターに出す。**バッジは指摘欄にフォーカスが無いときだけ表示**（入力中は数字が効かないので出さない。`focusin`/`focusout` で判定）。HTML（iframe）・画像・PDF は行を指せないので `max: 0`（Enter 空押しの「全体」だけ）
- **ピックで作る項目**: コードは `selectedText` = その行のテキスト（trim・120 文字。空行は `L12`）、`location = {line, label: 'L12'}`。Markdown は解決したブロックの `textContent`（ソース行だと記法が混ざって読みにくい）。送信本文は既存の整形（`「…」 (L12) について:`）に乗る。チャットは `anchor = {type:'message', messageUuid, quote}`（quote は本文を空白正規化して 80 文字）を App の `handlePickMessageForReview` → `ReviewDraftPanel` の `incomingAnchor`（`{anchor, nonce}`）で渡す。**App の `reviewItems`（サーバー保存分）には載せない**（本文が空の項目は保存対象外のため、パネルの draft 側で「末尾が空で引用なしの欄ならそこに引用を付け、無ければ末尾に追加」してフォーカスする）
- **番号の付け方**: チャットは **最新が 1**（見ているのは最新側なので、そこから数えられる方が探しやすい）。`ChatMessage` は `memo` なので `pickNumber` / `pickTarget` はピック中だけ渡す（それ以外は undefined＝再描画しない）。HUD（`.line-pick-hud` / `.msg-pick-hud`）に打鍵中の番号とヒントを出し、範囲外は `invalid` で赤くする
- 開いた直後の `PreviewDrawer` は本文（`tabIndex=-1`）にフォーカスを置くので、そのまま数字を打てる。指摘欄の `Ctrl+Enter` / `Esc` は本文へフォーカスを戻す（`Esc` は `stopPropagation` で document の「閉じる」に届かせない）
- **2 段構えの state**: `{active, buffer, sub}` で `sub` が `null` なら 1 段目、文字列なら 2 段目（チャットの「メッセージ番号 . 行番号」）。`.` が `sep`、2 段目の `⌫` は空のとき 1 段目へ戻る。`invertArrows` は 1 段目にだけ効かせる（行は上が小さい番号なので反転すると逆に迷う）。`useNumberPick` の `onKey(e, {target, subTarget})` は `keyToPickAction` より前に呼ばれ、true を返すと `preventDefault` して終わる。矢印の左右・`Tab`・`p` のような呼び出し側固有のキーはここに置く
- **Markdown の行対応づけは共用**: `utils/sourceBlocks.js`（`LEAF_BLOCKS` / `collectSourceBlocks` / `blockForLine`）と `utils/rehypeSourceLine.js` をプレビューとチャットで使う。ChatView の `REHYPE_PLUGINS` は**モジュール定数**（`components` / `remarkPlugins` と同じ理由で、inline で作ると本文が毎ポーリングごとに再マウントされる）。チャットの行モード（`pickLine !== undefined`）の間は `shouldCollapse` を無効にする（折りたたまれていると行が見えない）。行バッジ `.msg-line-badge` の位置は `getBoundingClientRect()` の差分で測るので `pickLine`・本文・`expanded` の変化で測り直し、`.chat-message` は素で padding を持たないので行モードのときだけ `padding-left: 34px` を足して居場所を作る。`p` / `Tab` のファイルリンク強調（`.msg-pick-file`）は className ではなく DOM 直接操作（`ChatMessage` の memo を崩さないため）。全文表示の操作は `expandCmd = {expanded, nonce}` を対象メッセージにだけ渡し、ChatMessage が `nonce` の変化で `setExpanded` する
- **指摘の削除キー**（`utils/keys.js` の `isDeleteItemShortcut`）: `Ctrl/Cmd+Shift+Backspace`（Delete）。**Shift 併用を必須にしてある**のは `Ctrl+Backspace` 単体が textarea の単語削除だから。`PreviewDrawer` は削除して本文へ（`removeItem` + `blurToBody`）、`ReviewDraftPanel` は削除して**直前の欄**へ（先頭を消したら残った先頭、最後の 1 件なら作り直した空欄）。そのため `removeItem(id, focusNeighbor)` は `setDraft` の更新関数の外で `draftRef.current` を起点に計算する（削除前の並び順が要る＋新 id を `setFocusId` に渡す必要があるため）
- **サイドバー最下部のカンペ** `ShortcutHints.jsx`: 「今の画面で使えるキー操作」を薄く一覧する。折りたたみ中は出さない。**状態は props ではなく DOM から読む**（ピックモードやドロワーの開閉は ChatView / PreviewDrawer のローカル state で、カンペのために App へ持ち上げると各コンポーネントに手が入るため）。`document.body` の `MutationObserver`（`attributeFilter: ['data-mode','class']`）＋ `focusin`/`focusout` で再判定し、コールバックは `requestAnimationFrame` で 1 フレームにまとめる。目印は `.home-view` / `.drawer-overlay` / `.line-pick-hud` / `.msg-pick-hud`（**`data-mode="line"` で 2 段目**。ChatView の HUD はこの属性を必ず付ける）/ `.review-draft-panel` と、activeElement の `.review-pane-input` / `.review-draft-item-input` / `.input-textarea`。**存在確認だけで中身は読まない**。`.session-tabs` は `flex-direction: column; overflow: hidden` なので `.tabs-list` に `flex: 1 1 auto; min-height: 0` が要る（無いとタブが増えたときに縮まずカンペを押し出す）

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
