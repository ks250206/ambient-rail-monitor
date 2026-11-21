import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import type { ProjectSpec } from '../shared/types.ts';
import { workflowFixture } from './workflow-fixture.ts';

function homeWithProjects(entries: unknown) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-projects-'));
  mkdirSync(path.join(home, 'data'), { recursive: true });
  writeFileSync(path.join(home, 'data', 'projects.json'), JSON.stringify(entries));
  return home;
}

function backups(home: string) {
  return readdirSync(path.join(home, 'data')).filter((name) =>
    name.startsWith('projects.json.corrupt-'),
  );
}

it('keeps unreadable project entries across later saves and backs up the original file', async () => {
  const broken = { id: 'broken', name: 'Broken', execution: { unknownKey: 1 } };
  const home = homeWithProjects([{ id: 'good', name: 'Good' }, broken]);
  const original = readFileSync(path.join(home, 'data', 'projects.json'), 'utf8');
  const f = await workflowFixture(home);
  try {
    const listed = await (await fetch(f.url + '/api/projects')).json();
    expect((listed as { projects: ProjectSpec[] }).projects.map((item) => item.id)).toEqual([
      'good',
    ]);
    const [backup] = backups(home);
    expect(backup).toBeDefined();
    expect(readFileSync(path.join(home, 'data', backup), 'utf8')).toBe(original);

    await f.json('/api/projects/good', { name: 'Good 2' }, 'PUT');
    // The unreadable id stays reserved so a new project cannot inherit its jobs.
    const { project } = await f.json<{ project: ProjectSpec }>('/api/projects', {
      id: 'broken',
      name: 'Another',
    });
    expect(project.id).toBe('broken-2');

    const saved = JSON.parse(
      readFileSync(path.join(home, 'data', 'projects.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    expect(saved.map((item) => item.id)).toEqual(['good', 'broken-2', 'broken']);
    expect(saved.find((item) => item.id === 'broken')).toEqual(broken);
    expect(saved.find((item) => item.id === 'good')?.name).toBe('Good 2');
  } finally {
    await f.close();
  }
});

it('still moves a wholly unreadable projects.json aside and starts with a default project', async () => {
  const home = homeWithProjects([{ id: 'only', name: 'Only', stages: [] }]);
  const f = await workflowFixture(home);
  try {
    const listed = (await (await fetch(f.url + '/api/projects')).json()) as {
      projects: ProjectSpec[];
    };
    expect(listed.projects.map((item) => item.id)).toEqual(['default']);
    const [backup] = backups(home);
    expect(JSON.parse(readFileSync(path.join(home, 'data', backup), 'utf8'))).toEqual([
      { id: 'only', name: 'Only', stages: [] },
    ]);
    const saved = JSON.parse(
      readFileSync(path.join(home, 'data', 'projects.json'), 'utf8'),
    ) as ProjectSpec[];
    expect(saved.map((item) => item.id)).toEqual(['default']);
  } finally {
    await f.close();
  }
});

it('accepts only one workflow save against the same revision and permits an explicit retry', async () => {
  const f = await workflowFixture();
  try {
    const { project } = await f.state();
    const route = '/api/projects/' + project.id;
    const save = (prompt: string, expectedUpdatedAt: string) =>
      f.response(route, { prompt, expectedUpdatedAt }, 'PUT');
    const responses = await Promise.all([
      save('first draft', project.updatedAt),
      save('other draft', project.updatedAt),
    ]);
    expect(responses.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const latest = (await f.state()).project;
    expect(latest.prompt).toBe(responses[0].ok ? 'first draft' : 'other draft');
    expect(latest.updatedAt > project.updatedAt).toBe(true);
    expect((await save('reviewed draft', latest.updatedAt)).ok).toBe(true);
    expect((await f.state()).project.prompt).toBe('reviewed draft');
  } finally {
    await f.close();
  }
});
