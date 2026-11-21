import { useI18n } from '../i18n.ts';

const sections = [
  ['#actions', 'ジョブ詳細', 'Job details'],
  ['#trace', 'トレース', 'Trace'],
  ['#events', 'イベント', 'Events'],
  ['#artifacts', '成果物', 'Artifacts'],
] as const;

export function SectionNavigation({ activeHash }: { activeHash: string }) {
  const { pick } = useI18n();
  return (
    <nav
      aria-label={pick('ページ内ナビゲーション', 'Page section navigation')}
      className="border-y border-line bg-white md:sticky md:top-0 md:z-20"
    >
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap">
        {sections.map(([hash, ja, en]) => (
          <a
            key={hash}
            href={hash}
            aria-current={activeHash === hash ? 'location' : undefined}
            className="section-link"
          >
            {pick(ja, en)}
          </a>
        ))}
      </div>
    </nav>
  );
}
