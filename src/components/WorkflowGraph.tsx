import { dependencies } from '../../shared/graph.ts';
import type { ProjectSpec, WorkflowJob } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';

export function WorkflowGraph({
  project,
  job,
  onSelect,
}: {
  project: ProjectSpec;
  job?: WorkflowJob;
  onSelect?: (key: string) => void;
}) {
  const { pick } = useI18n();
  if (!project.graph) return null;
  return (
    <details className="wf-disclosure" open={!job}>
      <summary>
        {pick(
          `工程の接続 · ${project.stages.length} 工程${job ? ` / ${job.stages.length} タスク` : ''} · 最大 ${project.graph.maxParallelTasks} タスク並列`,
          `Stage graph · ${project.stages.length} stages${job ? ` / ${job.stages.length} tasks` : ''} · max ${project.graph.maxParallelTasks} parallel`,
        )}
      </summary>
      <div
        className="workflow-graph"
        role="list"
        aria-label={pick('工程の依存関係', 'Stage dependencies')}
      >
        {project.stages.map((stage, i) => {
          const tasks = job?.stages.filter((task) => (task.stageKey ?? task.key) === stage.key);
          const parents = dependencies(project, stage);
          return (
            <div role="listitem" className="graph-node" key={`${stage.key}-${i}`}>
              <small>
                {parents.length
                  ? pick(
                      `${parents
                        .map((key) => project.stages.find((s) => s.key === key)?.label ?? key)
                        .join(' ＋ ')} の合格後`,
                      `After ${parents
                        .map((key) => project.stages.find((s) => s.key === key)?.label ?? key)
                        .join(' + ')}`,
                    )
                  : pick('入力がそろったら開始', 'Starts when inputs are ready')}
              </small>
              <strong>
                {stage.label}
                {stage.key === project.graph!.publishStage ? pick(' · 公開', ' · Publish') : ''}
              </strong>
              <span>
                {stage.runner?.kind ?? 'ai'}
                {stage.map
                  ? pick(
                      ` · ファイルごと: ${stage.map.pattern}`,
                      ` · per file: ${stage.map.pattern}`,
                    )
                  : ''}
              </span>
              {tasks?.length && onSelect ? (
                tasks.length === 1 ? (
                  <button className="wf-secondary" onClick={() => onSelect(tasks[0].key)}>
                    {pick(`「${stage.label}」の詳細を開く`, `Inspect "${stage.label}"`)}
                  </button>
                ) : (
                  <label>
                    {pick(`${stage.label}のタスク`, `Tasks in ${stage.label}`)}
                    <CustomSelect
                      ariaLabel={pick(`${stage.label}のタスク`, `Tasks in ${stage.label}`)}
                      value=""
                      placeholder={pick('ファイルを選択…', 'Select file…')}
                      options={tasks.map((task) => ({
                        value: task.key,
                        label: `${task.status === 'review' ? pick('要承認 · ', 'Needs approval · ') : ''}${task.item?.path ?? task.label}`,
                      }))}
                      onChange={onSelect}
                    />
                  </label>
                )
              ) : null}
              {tasks && (
                <span>
                  {pick(
                    `${tasks.filter((task) => task.status === 'success').length} / ${tasks.length} 合格`,
                    `${tasks.filter((task) => task.status === 'success').length} / ${tasks.length} passed`,
                  )}
                  {tasks.some((task) => task.status === 'review')
                    ? pick(' · レビュー待ちあり', ' · review pending')
                    : ''}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
