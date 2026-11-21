import { ChevronRight } from 'lucide-react';
import type { ProjectSpec } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { pageHref, rememberProjectId } from '../utils/workflow.ts';

export function ProjectList({ projects }: { projects: ProjectSpec[] }) {
  const { pick } = useI18n();
  return (
    <ul
      aria-label={pick('全プロジェクト', 'All projects')}
      className="divide-y divide-line border-y border-line"
    >
      {projects.map((project) => (
        <li key={project.id}>
          <a
            href={pageHref('/projects', project.id)}
            onClick={() => rememberProjectId(project.id)}
            className="flex items-center justify-between gap-4 px-3 py-4 hover:bg-bg-2"
          >
            <span className="min-w-0">
              <strong className="block break-words text-base text-science-blue">
                {project.name}
              </strong>
              <span className="block break-all font-mono text-xs text-ink-muted">{project.id}</span>
              {project.purpose && (
                <span className="mt-1.5 line-clamp-2 break-words text-sm text-ink">
                  {project.purpose}
                </span>
              )}
            </span>
            <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-eyebrow" />
          </a>
        </li>
      ))}
    </ul>
  );
}
