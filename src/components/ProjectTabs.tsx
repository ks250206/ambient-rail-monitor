import { ChevronRight } from 'lucide-react';
import { useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import type { ProjectSpec } from '../../shared/types.ts';

const tabs = [
  { id: 'info', label: 'プロジェクト情報' },
  { id: 'all', label: '全プロジェクト' },
] as const;

function subscribeTab(notify: () => void) {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

function currentTab() {
  return window.location.hash === '#all-projects' ? 'all' : 'info';
}

interface Props {
  projects: ProjectSpec[];
  onSelect: (id: string) => void;
  children: ReactNode;
}

export function ProjectTabs({ projects, onSelect, children }: Props) {
  const active = useSyncExternalStore(subscribeTab, currentTab);
  const infoTab = useRef<HTMLAnchorElement>(null);
  function navigate(event: KeyboardEvent<HTMLAnchorElement>) {
    const links =
      event.currentTarget.parentElement?.querySelectorAll<HTMLAnchorElement>('[role="tab"]');
    if (!links) return;
    let index;
    switch (event.key) {
      case 'Home':
        index = 0;
        break;
      case 'End':
        index = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        index = active === 'info' ? 1 : 0;
        break;
      case ' ':
        index = active === 'info' ? 0 : 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    links[index].focus();
    links[index].click();
  }
  return (
    <>
      <div role="tablist" aria-label="プロジェクト表示" className="mb-6 flex border-b border-line">
        {tabs.map(({ id, label }) => (
          <a
            key={id}
            ref={id === 'info' ? infoTab : undefined}
            id={`project-tab-${id}`}
            role="tab"
            href={id === 'all' ? '#all-projects' : '#project-info'}
            aria-selected={active === id}
            aria-controls={`project-panel-${id}`}
            tabIndex={active === id ? 0 : -1}
            onKeyDown={navigate}
            className={`border-b-2 px-4 py-2.5 text-sm font-bold ${active === id ? 'border-science-blue text-science-blue' : 'border-transparent text-ink-muted hover:bg-bg-2'}`}
          >
            {label}
          </a>
        ))}
      </div>
      <div
        hidden={active !== 'info'}
        role="tabpanel"
        id="project-panel-info"
        aria-labelledby="project-tab-info"
      >
        {children}
      </div>
      <div
        hidden={active !== 'all'}
        role="tabpanel"
        id="project-panel-all"
        aria-labelledby="project-tab-all"
      >
        <ul className="divide-y divide-line border-b border-line">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(project.id);
                  infoTab.current?.click();
                  infoTab.current?.focus();
                }}
                className="flex w-full items-center justify-between gap-4 px-3 py-4 text-left hover:bg-bg-2"
              >
                <span className="min-w-0">
                  <strong className="block break-words text-base text-science-blue">
                    {project.name}
                  </strong>
                  <span className="block break-all font-mono text-xs text-ink-muted">
                    {project.id}
                  </span>
                  {project.purpose && (
                    <span className="mt-1.5 line-clamp-2 break-words text-sm text-ink">
                      {project.purpose}
                    </span>
                  )}
                </span>
                <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-eyebrow" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
