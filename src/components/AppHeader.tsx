import type { ProjectSpec } from '../../shared/types.ts';
import { useClock } from '../api.ts';
import { clock, pageHref } from '../utils/workflow.ts';

const pages = [
  { id: 'projects', path: '/projects', label: 'プロジェクト' },
  { id: 'workflow', path: '/workflow', label: 'ワークフロー' },
  { id: 'jobs', path: '/jobs', label: 'ジョブ一覧' },
  { id: 'monitor', path: '/', label: '実行モニター' },
] as const;

interface AppHeaderProps {
  currentPage: 'list' | 'new' | (typeof pages)[number]['id'];
  projects: ProjectSpec[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  connection: 'connecting' | 'online' | 'reconnecting';
}

export function AppHeader(props: AppHeaderProps | { currentPage: 'home' }) {
  const { currentPage } = props;
  const projects = props.currentPage === 'home' ? [] : props.projects;
  const projectNames = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const { name } of projects) {
    if (projectNames.has(name)) duplicateNames.add(name);
    projectNames.add(name);
  }
  const scoped = currentPage !== 'home' && currentPage !== 'list' && currentPage !== 'new';
  return (
    <header className="border-t-4 border-science-blue border-b border-b-line bg-white">
      <div className="page-width flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-5">
          <a
            href="/"
            aria-current={currentPage === 'home' ? 'page' : undefined}
            lang="en"
            className="font-en text-xl font-semibold tracking-wide text-science-blue sm:text-2xl"
          >
            RAILFLOW
          </a>

          <nav aria-label="プロジェクト階層" className="flex flex-wrap items-center gap-2 text-xs">
            <a
              href="/projects"
              aria-current={currentPage === 'list' ? 'page' : undefined}
              className="font-semibold text-science-blue hover:underline"
            >
              プロジェクト一覧
            </a>
            {(scoped || currentPage === 'list') && (
              <>
                <span aria-hidden="true" className="text-ink-muted">
                  /
                </span>
                <label className="inline-flex items-center gap-2 text-xs">
                  <select
                    aria-label="プロジェクト切替"
                    value={currentPage === 'list' ? '' : props.selectedProjectId}
                    disabled={currentPage === 'list' && projects.length === 0}
                    onChange={(event) => props.onSelectProject(event.target.value)}
                    className="max-w-[220px] rounded-md border border-line bg-bg-2 px-2.5 py-1.5 text-xs font-bold text-science-blue focus:border-science-blue focus:bg-white focus:outline-none"
                  >
                    {currentPage === 'list' && (
                      <option value="" disabled>
                        プロジェクトを選択
                      </option>
                    )}
                    {projects.length === 0 && scoped ? (
                      <option value={props.selectedProjectId}>{props.selectedProjectId}</option>
                    ) : (
                      projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                          {duplicateNames.has(project.name) && ` (${project.id})`}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </>
            )}
          </nav>

          {scoped && (
            <nav aria-label="ページ切替" className="flex flex-wrap items-center gap-1">
              {pages.map(({ id, path, label }) => (
                <a
                  key={id}
                  href={pageHref(path, props.selectedProjectId)}
                  aria-current={currentPage === id ? 'page' : undefined}
                  className={`rounded-md px-2 py-1.5 text-xs font-bold transition-colors sm:px-3 ${currentPage === id ? 'bg-science-blue text-white' : 'text-science-blue hover:bg-bg-2'}`}
                >
                  {label}
                </a>
              ))}
            </nav>
          )}
        </div>

        {props.currentPage !== 'home' && (
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${props.connection === 'online' ? 'bg-st-green' : 'bg-st-orange'}`}
            />
            <span>
              {props.connection === 'online'
                ? 'オンライン'
                : props.connection === 'connecting'
                  ? '接続を開始しています'
                  : '再接続中'}
            </span>
            <HeaderClock />
          </div>
        )}
      </div>
    </header>
  );
}

function HeaderClock() {
  const nowMs = useClock();
  return (
    <time className="hidden border-l border-line pl-3 font-mono sm:inline">
      {clock(new Date(nowMs).toISOString())}
    </time>
  );
}
