import { useState } from "react";
import "./TaskStrip.css";

// 完了タスクをそのまま出し続けると邪魔なので、この件数を超えたら折りたたむ
const COMPLETED_VISIBLE = 3;

function taskLabel(task) {
  return task.description || task.agentType || task.agentId;
}

// セッションが起動したサブエージェントのチップ列（入力欄の直上）。
// クリックでそのサブエージェントの会話をドロワーで開く。
export default function TaskStrip({ tasks, onOpenTask }) {
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  if (!tasks || tasks.length === 0) return null;

  const running = tasks.filter((t) => t.status === "running");
  const completed = tasks.filter((t) => t.status !== "running");
  const visibleCompleted = showAllCompleted
    ? completed
    : completed.slice(0, COMPLETED_VISIBLE);
  const hiddenCount = completed.length - visibleCompleted.length;

  return (
    <div className="task-strip">
      <span className="task-strip-label">Tasks</span>
      {running.map((task) => (
        <button
          key={task.agentId}
          className="task-chip task-chip-running"
          onClick={() => onOpenTask(task)}
          title={`${task.agentType || "agent"} — 実行中`}
        >
          <span className="task-chip-icon">⚙</span>
          <span className="task-chip-text">{taskLabel(task)}</span>
        </button>
      ))}
      {visibleCompleted.map((task) => (
        <button
          key={task.agentId}
          className="task-chip task-chip-done"
          onClick={() => onOpenTask(task)}
          title={`${task.agentType || "agent"} — 完了`}
        >
          <span className="task-chip-icon">✓</span>
          <span className="task-chip-text">{taskLabel(task)}</span>
        </button>
      ))}
      {hiddenCount > 0 && (
        <button
          className="task-chip task-chip-more"
          onClick={() => setShowAllCompleted(true)}
          title="完了したタスクをすべて表示"
        >
          ✓ 他 {hiddenCount} 件
        </button>
      )}
      {showAllCompleted && completed.length > COMPLETED_VISIBLE && (
        <button
          className="task-chip task-chip-more"
          onClick={() => setShowAllCompleted(false)}
          title="完了したタスクを折りたたむ"
        >
          折りたたむ
        </button>
      )}
    </div>
  );
}
