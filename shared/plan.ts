import { createHash } from 'node:crypto';
import { matchesPattern } from './conditions.ts';
import { dependencies, type PlannedTask } from './graph.ts';
import type { DatasetManifest, ProjectSpec } from './types.ts';

/** Expand only the frozen dataset, never a live directory or an execution result. */
export function planWorkflow(project: ProjectSpec, dataset: DatasetManifest): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  for (const stage of project.stages) {
    if (stage.map) {
      const files = dataset.files.filter((file) => matchesPattern(file.path, stage.map!.pattern));
      if (!files.length || files.length > stage.map.maxItems)
        throw new Error(
          `${stage.label}: map対象は1〜${stage.map.maxItems}件です（現在${files.length}件）。`,
        );
      for (const file of files)
        tasks.push({
          key: stage.key + '__' + createHash('sha256').update(file.path).digest('hex').slice(0, 16),
          stageKey: stage.key,
          label: `${stage.label} / ${file.path}`,
          short: stage.short,
          item: { path: file.path, hash: file.hash },
          dependsOn: [],
        });
    } else
      tasks.push({
        key: stage.key,
        stageKey: stage.key,
        label: stage.label,
        short: stage.short,
        dependsOn: [],
      });
  }
  if (tasks.length > 256 || new Set(tasks.map((task) => task.key)).size !== tasks.length)
    throw new Error('実行タスクは重複しない256件以内にしてください。');
  for (const task of tasks) {
    const parents = dependencies(
      project,
      project.stages.find((stage) => stage.key === task.stageKey)!,
    );
    task.dependsOn = tasks
      .filter((candidate) => parents.includes(candidate.stageKey))
      .map((candidate) => candidate.key)
      .sort();
  }
  return tasks;
}
