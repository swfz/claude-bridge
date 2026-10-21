// セッション中に Claude が触ったファイル（Read / Edit / Write / NotebookEdit / Artifact の publish）を集める純粋関数群。
// Refs ドロワー（FileList）がチャットの messages からクライアント側だけで一覧を作る（サーバーには取りに行かない）。

// ツール名 → 数える op と、パスを持つ input のキー
const TOOL_OPS = {
  Read: { op: 'read', key: 'file_path' },
  Edit: { op: 'edit', key: 'file_path' },
  MultiEdit: { op: 'edit', key: 'file_path' },
  Write: { op: 'write', key: 'file_path' },
  NotebookEdit: { op: 'edit', key: 'notebook_path' },
};

function isAbsolutePath(p) {
  return typeof p === 'string' && p.startsWith('/');
}

// tool_use 1 件から {path, op} を返す。対象外・不正なら null
function fileOpOf(tool) {
  if (!tool || typeof tool.input !== 'object' || tool.input === null) return null;
  if (tool.name === 'Artifact') {
    const { action, file_path: filePath } = tool.input;
    // publish 以外（asset 系など）と file_path 無しは数えない
    if (action !== undefined && action !== 'publish') return null;
    if (tool.input.asset) return null;
    return isAbsolutePath(filePath) ? { path: filePath, op: 'artifact' } : null;
  }
  const spec = TOOL_OPS[tool.name];
  if (!spec) return null;
  const path = tool.input[spec.key];
  return isAbsolutePath(path) ? { path, op: spec.op } : null;
}

// messages からパスごとに 1 件の一覧を作る。並びは最後の出現が新しい順
// （timestamp が両方あればそれで、無ければメッセージの出現順。collectLinks と同じ）
export function collectSessionFiles(messages) {
  if (!Array.isArray(messages)) return [];

  const byPath = new Map();
  messages.forEach((msg, index) => {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.toolUses)) return;
    const uuid = msg.uuid || null;
    const timestamp = msg.timestamp || '';
    for (const tool of msg.toolUses) {
      const hit = fileOpOf(tool);
      if (!hit) continue;
      let entry = byPath.get(hit.path);
      if (!entry) {
        entry = {
          path: hit.path,
          ops: { read: 0, edit: 0, write: 0, artifact: 0 },
          count: 0,
          firstUuid: uuid,
          lastUuid: uuid,
          lastTimestamp: timestamp,
          lastIndex: index,
        };
        byPath.set(hit.path, entry);
      }
      entry.ops[hit.op] += 1;
      entry.count += 1;
      if (!entry.firstUuid) entry.firstUuid = uuid;
      // uuid の無いメッセージでジャンプ先を失わないよう、直前の uuid を引き継ぐ
      entry.lastUuid = uuid || entry.lastUuid;
      entry.lastTimestamp = timestamp || entry.lastTimestamp;
      entry.lastIndex = index;
    }
  });

  const sorted = [...byPath.values()].sort((a, b) => {
    if (a.lastTimestamp && b.lastTimestamp && a.lastTimestamp !== b.lastTimestamp) {
      return b.lastTimestamp.localeCompare(a.lastTimestamp);
    }
    return b.lastIndex - a.lastIndex;
  });
  return sorted.map(({ lastIndex: _lastIndex, ...file }) => file);
}

// cwd 配下なら相対パス、それ以外はそのまま（home 置換はしない）。表示用
export function relativeToCwd(path, cwd) {
  if (typeof path !== 'string') return '';
  if (typeof cwd !== 'string' || !cwd) return path;
  const base = cwd.replace(/\/+$/, '');
  if (!base) return path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

// 変更（edit / write / artifact のどれかがある）か
export function isModified(file) {
  return file.ops.edit > 0 || file.ops.write > 0 || file.ops.artifact > 0;
}

// クリップボードコピー用の Markdown（1 行 1 ファイル）
export function filesToMarkdown(files, cwd) {
  if (!Array.isArray(files)) return '';
  return files.map((file) => `- ${relativeToCwd(file.path, cwd)}`).join('\n');
}
