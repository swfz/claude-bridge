import { useState } from 'react';
import './TaskStrip.css';

// 完了タスクをそのまま出し続けると邪魔なので、この件数を超えたら折りたたむ
// （サブエージェントと終了済みシェルをまとめて数える）
const COMPLETED_VISIBLE = 3;

function taskLabel(task) {
  return task.description || task.agentType || task.agentId;
}

// シェルは「どの Bash か」のラベルが最善努力なので、無ければ末尾行・taskId まで落とす
function shellLabel(task) {
  return task.label || task.preview || task.taskId;
}

function shellTitle(task) {
  const state = task.status === 'running' ? '実行中' : `終了 (code ${task.exitCode ?? '?'})`;
  return `bash — ${state}${task.background ? '（バックグラウンド）' : ''} · ${task.taskId}`;
}

// セッションが起動したサブエージェントと Bash 出力のチップ列（入力欄の直上）。
// クリックでサブエージェントの会話／シェルの出力をドロワーで開く。
export default function TaskStrip({ tasks, shellTasks, onOpenTask, onOpenShellTask }) {
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  const agents = tasks || [];
  const shells = shellTasks || [];
  if (agents.length === 0 && shells.length === 0) return null;

  const runningAgents = agents.filter((t) => t.status === 'running');
  const runningShells = shells.filter((t) => t.status === 'running');
  // 終了済みは種別を混ぜて 1 つの折りたたみにまとめる（どちらも「もう見なくてよい」もの）
  const completed = [
    ...agents.filter((t) => t.status !== 'running').map((task) => ({ kind: 'agent', task })),
    ...shells.filter((t) => t.status !== 'running').map((task) => ({ kind: 'shell', task })),
  ];
  const visibleCompleted = showAllCompleted ? completed : completed.slice(0, COMPLETED_VISIBLE);
  const hiddenCount = completed.length - visibleCompleted.length;

  const renderAgent = (task, done) => (
    <button
      key={`agent-${task.agentId}`}
      className={`task-chip ${done ? 'task-chip-done' : 'task-chip-running'}`}
      onClick={() => onOpenTask(task)}
      title={`${task.agentType || 'agent'} — ${done ? '完了' : '実行中'}`}
    >
      <span className="task-chip-icon">{done ? '✓' : '⚙'}</span>
      <span className="task-chip-text">{taskLabel(task)}</span>
    </button>
  );

  const renderShell = (task) => {
    const running = task.status === 'running';
    // 終了コードが 0 以外なら失敗として区別する（exitCode 不明は成功扱いにしない）
    const failed = !running && task.exitCode !== 0;
    return (
      <button
        key={`shell-${task.taskId}`}
        className={`task-chip ${running ? 'task-chip-running' : failed ? 'task-chip-failed' : 'task-chip-done'}`}
        onClick={() => onOpenShellTask(task)}
        title={shellTitle(task)}
      >
        <span className="task-chip-icon">{running ? '$' : failed ? '✗' : '✓'}</span>
        <span className="task-chip-text">{shellLabel(task)}</span>
      </button>
    );
  };

  return (
    <div className="task-strip">
      <span className="task-strip-label">Tasks</span>
      {runningAgents.map((task) => renderAgent(task, false))}
      {runningShells.map(renderShell)}
      {visibleCompleted.map((item) => (item.kind === 'agent' ? renderAgent(item.task, true) : renderShell(item.task)))}
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
