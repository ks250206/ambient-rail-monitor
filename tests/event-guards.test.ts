import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import type { ClaimResponse, WorkflowEvent, WorkflowJob } from '../shared/types.ts';
import { workflowFixture } from './workflow-fixture.ts';

it('enforces execution order and computes gate evidence rather than accepting worker-supplied success', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'guard',
      name: 'Guard',
      execution: { onFailure: 'stop' },
      stages: [
        {
          key: 'fit',
          label: 'Fit',
          gate: {
            condition: {
              op: 'json.value',
              path: 'metrics.json',
              field: 'ok',
              compare: 'eq',
              value: true,
            },
          },
        },
      ],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'guard' });
    const claim = await f.json<ClaimResponse>('/api/jobs/claim');
    const work = '.attempts/fit/1';
    mkdirSync(path.join(claim.paths!.work, work), { recursive: true });
    writeFileSync(path.join(claim.paths!.work, work, 'metrics.json'), '{"ok":false}');
    const post = (type: string, extra = {}) =>
      f.response(`/api/jobs/${job.id}/events`, {
        type,
        stage: 'fit',
        attempt: 1,
        leaseToken: claim.lease!.token,
        ...extra,
      });
    expect((await post('stage.started', { workspace: work })).status).toBe(200);
    for (const type of ['gate.evaluated', 'stage.succeeded', 'review.required'])
      expect((await post(type, { gate: { scope: 'stage' } })).status).toBe(409);
    expect((await post('stage.executed')).status).toBe(200);
    const response = await post('gate.evaluated', {
      gate: { scope: 'stage', result: { status: 'pass' } },
    });
    expect(response.status).toBe(200);
    const { event } = (await response.json()) as { event: WorkflowEvent };
    expect(event.gate?.result.status).toBe('fail');
    expect((await post('stage.succeeded')).status).toBe(409);
    expect((await post('review.required')).status).toBe(409);
    expect((await post('stage.failed', { failureKind: 'acceptance_failed' })).status).toBe(200);
    expect((await post('review.required')).status).toBe(409);
  } finally {
    await f.close();
  }
});
