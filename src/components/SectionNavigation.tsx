const sections = [
  ['#board', 'ジョブボード'],
  ['#actions', '実行履歴'],
  ['#trace', 'トレース'],
  ['#events', 'イベント'],
];

export function SectionNavigation({ activeHash }: { activeHash: string }) {
  return (
    <nav
      aria-label="ページ内ナビゲーション"
      className="border-y border-line bg-white md:sticky md:top-0 md:z-20"
    >
      <div className="page-width grid grid-cols-2 sm:flex sm:flex-wrap">
        <a href="/workflow" className="section-link">
          ワークフロー定義 ↗
        </a>
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
