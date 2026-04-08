import { watch, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// cwd からプロジェクトディレクトリ名を算出
// e.g. /path/to/project → -path-to-project
function cwdToProjectDir(cwd) {
  return cwd.replace(/\//g, "-");
}

// message オブジェクトからテキストを取り出す
function extractText(msg) {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

export class JsonlWatcher {
  constructor() {
    // sessionId -> watcher state
    this.watchers = new Map();
  }

  // セッション開始時に呼ぶ
  // resumeSessionId がある場合はそのファイルを直接監視
  // ない場合は cwd のプロジェクトディレクトリ内の最新ファイルを検出
  startWatching({ bridgeSessionId, cwd, resumeSessionId, onMessage }) {
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
    }

    const state = {
      bridgeSessionId,
      cwd,
      projectPath,
      targetFile,
      linesRead,
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

  // プロジェクトディレクトリ内の最新 JSONL を検出
  _detectNewFile(state) {
    try {
      const files = readdirSync(state.projectPath)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          name: f,
          path: join(state.projectPath, f),
          mtime: statSync(join(state.projectPath, f)).mtime,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const newest = files[0];
        // 直近 10 秒以内に更新されたファイルのみ
        if (Date.now() - newest.mtime.getTime() < 10000) {
          if (state.targetFile !== newest.path) {
            state.targetFile = newest.path;
            state.linesRead = 0;
            clearInterval(state.pollTimer);
            state.pollTimer = null;
            this._startFileWatch(state);
            // 既存行を読む
            this._readNewLines(state);
          }
        }
      }
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
          const text = extractText(record.message);
          if (text) {
            state.onMessage({
              type: "chat_message",
              bridgeSessionId: state.bridgeSessionId,
              role: "human",
              content: text,
              timestamp: record.timestamp || "",
            });
          }
        } else if (record.type === "assistant") {
          const text = extractText(record.message);
          if (text) {
            state.onMessage({
              type: "chat_message",
              bridgeSessionId: state.bridgeSessionId,
              role: "assistant",
              content: text,
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
