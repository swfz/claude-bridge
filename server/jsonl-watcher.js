import { watch, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import {
  CLAUDE_PROJECTS_DIR,
  cwdToProjectDir,
  extractTextContent,
  extractToolUses,
} from "./jsonl-utils.js";

export class JsonlWatcher {
  constructor() {
    // sessionId -> watcher state
    this.watchers = new Map();
  }

  // セッション開始時に呼ぶ
  // resumeSessionId がある場合はそのファイルを直接監視
  // ない場合は cwd のプロジェクトディレクトリ内の最新ファイルを検出
  startWatching({ bridgeSessionId, cwd, resumeSessionId, attachExisting, onMessage }) {
    const projectDir = cwdToProjectDir(cwd);
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);

    let targetFile = null;
    let linesRead = 0;

    if (resumeSessionId) {
      targetFile = join(projectPath, `${resumeSessionId}.jsonl`);
      // resume の場合、既存の行数をカウントしてスキップ
      try {
        const existing = readFileSync(targetFile, "utf-8");
        linesRead = existing.split("\n").filter((l) => l.trim()).length;
      } catch {
        // ファイルがまだない場合
      }
    } else if (attachExisting) {
      // tmux 等の既存セッションに接続: 最新ファイルを即座に特定（recency チェックなし）
      targetFile = this._findLatestJsonl(projectPath);
      // 既存行はスキップし、新規メッセージのみ配信
      if (targetFile) {
        try {
          const existing = readFileSync(targetFile, "utf-8");
          linesRead = existing.split("\n").filter((l) => l.trim()).length;
        } catch {
          // ignore
        }
      }
    }

    const state = {
      bridgeSessionId,
      cwd,
      projectPath,
      targetFile,
      linesRead,
      attachExisting: !!attachExisting,
      onMessage,
      fsWatcher: null,
      pollTimer: null,
    };

    this.watchers.set(bridgeSessionId, state);

    // ファイルが特定できていない場合はポーリングで検出
    if (!targetFile) {
      state.pollTimer = setInterval(() => {
        this._detectNewFile(state);
      }, 1000);
    }

    // ファイル監視を開始
    this._startFileWatch(state);
  }

  // cwd からプロジェクトディレクトリと最新セッション ID を返す
  findSessionForCwd(cwd) {
    const projectDir = cwdToProjectDir(cwd);
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
    const filePath = this._findLatestJsonl(projectPath);
    if (!filePath) return null;
    const sessionId = basename(filePath, ".jsonl");
    return { sessionId, projectDir };
  }

  // プロジェクトディレクトリ内の最新 JSONL ファイルパスを返す
  _findLatestJsonl(projectPath) {
    try {
      const files = readdirSync(projectPath)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          path: join(projectPath, f),
          mtime: statSync(join(projectPath, f)).mtime,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      return files.length > 0 ? files[0].path : null;
    } catch {
      return null;
    }
  }

  // プロジェクトディレクトリ内の最新 JSONL を検出
  _detectNewFile(state) {
    const newestPath = this._findLatestJsonl(state.projectPath);
    if (!newestPath || state.targetFile === newestPath) return;

    try {
      // 新規セッション検出時は直近10秒以内のファイルのみ対象
      if (!state.attachExisting) {
        const mtime = statSync(newestPath).mtime;
        if (Date.now() - mtime.getTime() >= 10000) return;
      }

      state.targetFile = newestPath;
      state.linesRead = 0;
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      this._startFileWatch(state);
      this._readNewLines(state);
    } catch {
      // ディレクトリがまだない等
    }
  }

  _startFileWatch(state) {
    if (state.fsWatcher) {
      state.fsWatcher.close();
    }

    const pathToWatch = state.targetFile || state.projectPath;

    try {
      state.fsWatcher = watch(pathToWatch, { persistent: false }, () => {
        // ファイルが未特定ならまず検出
        if (!state.targetFile) {
          this._detectNewFile(state);
        } else {
          this._readNewLines(state);
        }
      });
    } catch {
      // 監視対象がまだ存在しない場合、ディレクトリを監視
      try {
        state.fsWatcher = watch(
          state.projectPath,
          { persistent: false },
          () => {
            if (!state.targetFile) {
              this._detectNewFile(state);
            } else {
              this._readNewLines(state);
            }
          }
        );
      } catch {
        // プロジェクトディレクトリ自体がない場合はポーリングで待つ
        if (!state.pollTimer) {
          state.pollTimer = setInterval(() => {
            this._detectNewFile(state);
          }, 2000);
        }
      }
    }
  }

  _readNewLines(state) {
    if (!state.targetFile) return;

    let content;
    try {
      content = readFileSync(state.targetFile, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n").filter((l) => l.trim());
    const newLines = lines.slice(state.linesRead);
    state.linesRead = lines.length;

    for (const line of newLines) {
      try {
        const record = JSON.parse(line);
        if (record.type === "user") {
          const text = extractTextContent(record.message);
          if (text) {
            state.onMessage({
              type: "chat_message",
              bridgeSessionId: state.bridgeSessionId,
              role: "human",
              content: text,
              timestamp: record.timestamp || "",
            });
          }
        } else if (record.type === "queue-operation" && record.operation === "enqueue" && record.content) {
          state.onMessage({
            type: "chat_message",
            bridgeSessionId: state.bridgeSessionId,
            role: "human",
            content: record.content,
            timestamp: record.timestamp || "",
          });
        } else if (record.type === "assistant") {
          const text = extractTextContent(record.message);
          const toolUses = extractToolUses(record.message);
          if (text || toolUses.length > 0) {
            state.onMessage({
              type: "chat_message",
              bridgeSessionId: state.bridgeSessionId,
              role: "assistant",
              content: text,
              toolUses: toolUses.length > 0 ? toolUses : undefined,
              timestamp: record.timestamp || "",
            });
          }
        }
      } catch {
        // パース失敗はスキップ
      }
    }
  }

  stopWatching(bridgeSessionId) {
    const state = this.watchers.get(bridgeSessionId);
    if (state) {
      if (state.fsWatcher) state.fsWatcher.close();
      if (state.pollTimer) clearInterval(state.pollTimer);
      this.watchers.delete(bridgeSessionId);
    }
  }

  stopAll() {
    for (const [id] of this.watchers) {
      this.stopWatching(id);
    }
  }
}
