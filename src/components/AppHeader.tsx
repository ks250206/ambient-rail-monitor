import type { ProjectSpec } from '../../shared/types.ts';
import { useClock } from '../api.ts';
import { useI18n } from '../i18n.ts';
import { clock, pageHref } from '../utils/workflow.ts';
import { CustomSelect } from './CustomSelect.tsx';

const pages = [
  { id: 'projects', path: '/projects', ja: 'プロジェクト', en: 'Project' },
  { id: 'workflow', path: '/workflow', ja: 'ワークフロー', en: 'Workflow' },
  { id: 'jobs', path: '/jobs', ja: 'ジョブ一覧', en: 'Jobs' },
  { id: 'monitor', path: '/', ja: '実行モニター', en: 'Monitor' },
] as const;

interface AppHeaderProps {
  currentPage: 'list' | 'new' | (typeof pages)[number]['id'];
  projects: ProjectSpec[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  connection: 'connecting' | 'online' | 'reconnecting';
}

export function AppHeader(props: AppHeaderProps | { currentPage: 'home' }) {
  const { locale, setLocale, pick } = useI18n();
  const { currentPage } = props;
  const projects = props.currentPage === 'home' ? [] : props.projects;
  const projectNames = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const { name } of projects) {
    if (projectNames.has(name)) duplicateNames.add(name);
    projectNames.add(name);
  }
  const scoped = currentPage !== 'home' && currentPage !== 'list' && currentPage !== 'new';
  const selectOptions =
    projects.length === 0 && scoped
      ? [{ value: props.selectedProjectId, label: props.selectedProjectId }]
      : projects.map((project) => ({
          value: project.id,
          label: duplicateNames.has(project.name)
            ? `${project.name} (${project.id})`
            : project.name,
        }));

  return (
    <header className="app-header border-t-4 border-science-blue border-b border-b-line bg-white">
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

          <nav
            aria-label={pick('プロジェクト階層', 'Project hierarchy')}
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <a
              href="/projects"
              aria-current={currentPage === 'list' ? 'page' : undefined}
              className="font-semibold text-science-blue hover:underline"
            >
              {pick('プロジェクト一覧', 'Projects')}
            </a>
            {(scoped || currentPage === 'list') && (
              <>
                <span aria-hidden="true" className="text-ink-muted">
                  /
                </span>
                <div className="w-[200px] max-w-[220px]">
                  <CustomSelect
                    ariaLabel={pick('プロジェクト切替', 'Switch project')}
                    value={currentPage === 'list' ? '' : props.selectedProjectId}
                    disabled={currentPage === 'list' && projects.length === 0}
                    placeholder={pick('プロジェクトを選択', 'Select project')}
                    options={selectOptions}
                    onChange={(value) => props.onSelectProject(value)}
                    className="rf-select-header"
                    size="sm"
                  />
                </div>
              </>
            )}
          </nav>

          {scoped && (
            <nav
              aria-label={pick('ページ切替', 'Page navigation')}
              className="flex flex-wrap items-center gap-1"
            >
              {pages.map(({ id, path, ja, en }) => (
                <a
                  key={id}
                  href={pageHref(path, props.selectedProjectId)}
                  aria-current={currentPage === id ? 'page' : undefined}
                  className={`rounded-md px-2 py-1.5 text-xs font-bold transition-colors sm:px-3 ${currentPage === id ? 'bg-science-blue text-white' : 'text-science-blue hover:bg-bg-2'}`}
                >
                  {pick(ja, en)}
                </a>
              ))}
            </nav>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <div
            role="group"
            aria-label={pick('表示言語', 'Display language')}
            className="rf-lang-switch"
          >
            <button type="button" aria-pressed={locale === 'ja'} onClick={() => setLocale('ja')}>
              JA
            </button>
            <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
              EN
            </button>
          </div>
          {props.currentPage !== 'home' && (
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${props.connection === 'online' ? 'bg-st-green' : 'bg-st-orange'}`}
              />
              <span>
                {props.connection === 'online'
                  ? pick('オンライン', 'Online')
                  : props.connection === 'connecting'
                    ? pick('接続を開始しています', 'Connecting')
                    : pick('再接続中', 'Reconnecting')}
              </span>
              <HeaderClock />
            </div>
          )}
        </div>
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
