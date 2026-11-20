const sections = [
  ['#overview', '概要'],
  ['#actions', '実行履歴'],
  ['#board', 'ジョブボード'],
  ['#railway', '実行工程'],
  ['#trace', 'トレース'],
  ['#events', 'イベント'],
];

export function SectionNavigation({ activeHash }: { activeHash: string }) {
  return (
    <nav
      aria-label="ページ内ナビゲーション"
      className="border-y border-line bg-white md:sticky md:top-0 md:z-20"
    >
      <div className="page-width grid grid-cols-3 sm:flex sm:flex-wrap">
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
