import { dependencies } from '../../shared/graph.ts';
import type { ProjectSpec, WorkflowJob } from '../../shared/types.ts';

export function WorkflowGraph({
  project,
  job,
  onSelect,
}: {
  project: ProjectSpec;
  job?: WorkflowJob;
  onSelect?: (key: string) => void;
}) {
  if (!project.graph) return null;
  return (
    <details className="wf-disclosure" open={!job}>
      <summary>
        工程の接続 · {project.stages.length} 工程{job ? ` / ${job.stages.length} タスク` : ''} ·
        最大 {project.graph.maxParallelTasks} タスク並列
      </summary>
      <div className="workflow-graph" role="list" aria-label="工程の依存関係">
        {project.stages.map((stage, i) => {
          const tasks = job?.stages.filter((task) => (task.stageKey ?? task.key) === stage.key);
          const parents = dependencies(project, stage);
          return (
            <div role="listitem" className="graph-node" key={`${stage.key}-${i}`}>
              <small>
                {parents.length
                  ? parents
                      .map((key) => project.stages.find((s) => s.key === key)?.label ?? key)
                      .join(' ＋ ') + ' の合格後'
                  : '入力がそろったら開始'}
              </small>
              <strong>
                {stage.label}
                {stage.key === project.graph!.publishStage ? ' · 公開' : ''}
              </strong>
              <span>
                {stage.runner?.kind ?? 'ai'}
                {stage.map ? ` · ファイルごと: ${stage.map.pattern}` : ''}
              </span>
              {tasks?.length && onSelect ? (
                tasks.length === 1 ? (
                  <button className="wf-secondary" onClick={() => onSelect(tasks[0].key)}>
                    「{stage.label}」の詳細を開く
                  </button>
                ) : (
                  <label>
                    {stage.label}のタスク
                    <select className="w-full" value="" onChange={(e) => onSelect(e.target.value)}>
                      <option value="" disabled>
                        ファイルを選択…
                      </option>
                      {tasks.map((task) => (
                        <option key={task.key} value={task.key}>
                          {task.status === 'review' ? '要承認 · ' : ''}
                          {task.item?.path ?? task.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              ) : null}
              {tasks && (
                <span>
                  {tasks.filter((task) => task.status === 'success').length} / {tasks.length} 合格
                  {tasks.some((task) => task.status === 'review') ? ' · レビュー待ちあり' : ''}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
