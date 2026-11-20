const sections = [
  ['#actions', 'ジョブ詳細'],
  ['#trace', 'トレース'],
  ['#events', 'イベント'],
  ['#artifacts', '成果物'],
];

export function SectionNavigation({ activeHash }: { activeHash: string }) {
  return (
    <nav
      aria-label="ページ内ナビゲーション"
      className="border-y border-line bg-white md:sticky md:top-0 md:z-20"
    >
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap">
        {sections.map(([hash, label]) => (
          <a
            key={hash}
            href={hash}
            aria-current={activeHash === hash ? 'location' : undefined}
            className="section-link"
          >
            {label}
          </a>
        ))}
      </div>
    </nav>
  );
}
