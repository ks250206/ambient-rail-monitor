import {
  Activity,
  GitBranch,
  Kanban,
  LayoutGrid,
  ListTree,
  Play,
  Radio,
  Terminal,
} from 'lucide-react';

interface SidebarProps {
  activeHash: string;
  onNavigate: (hash: string) => void;
  activeAgents: {
    codex: boolean;
    claude: boolean;
    demo: boolean;
  };
}

const NAV_ITEMS = [
  { hash: '#overview', label: 'Overview', icon: LayoutGrid, pill: 'LIVE' },
  { hash: '#actions', label: 'Actions / Runs', icon: Play, pill: 'LOGS' },
  { hash: '#board', label: 'Kanban board', icon: Kanban },
  { hash: '#railway', label: 'Railway execution', icon: GitBranch },
  { hash: '#trace', label: 'Trace explorer', icon: Activity },
  { hash: '#events', label: 'Event stream', icon: ListTree },
];

export function Sidebar({ activeHash, onNavigate, activeAgents }: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-bg-2 lg:flex">
      {/* Science Blue primary brand band — text only, no fabricated university logo */}
      <div className="relative overflow-hidden bg-science-blue px-5 pb-5 pt-6 text-white">
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 256 124"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect width="256" height="124" fill="#1c3177" />
          <polygon points="0,98 256,118 256,124 0,124" fill="#7f96c2" />
        </svg>
        <div className="relative">
          <p className="font-en text-[10px] font-semibold tracking-[0.16em] text-navy-200 uppercase">
            Science Tokyo
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <strong className="font-en text-xl font-bold tracking-[0.08em] text-white">
              RAILFLOW
            </strong>
            <span className="rounded bg-white/15 px-1.5 py-0.5 font-mono text-[10px] text-navy-100">
              v0.3
            </span>
          </div>
          <p className="font-en mt-0.5 text-[11px] text-navy-200">Ambient Agent Observability</p>
        </div>
      </div>

      {/* Workspace summary card */}
      <div className="px-4 pt-4">
        <div className="rounded-lg border border-line bg-white px-3.5 py-2.5 shadow-2xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-en text-[12px] font-semibold text-science-blue">
              Research Workspace
            </span>
            <span className="rounded bg-bg-1 px-1.5 py-0.5 font-mono text-[10px] font-medium text-eyebrow">
              LOCAL
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            Institute of Science Tokyo · Event-driven
          </p>
        </div>
      </div>

      {/* Navigation */}
      <div className="mt-5 px-3">
        <p className="font-en px-2.5 text-[10px] font-bold tracking-[0.14em] text-eyebrow uppercase">
          Workspace
        </p>
        <nav className="mt-2 space-y-1" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeHash === item.hash;
            return (
              <a
                key={item.hash}
                href={item.hash}
                onClick={() => onNavigate(item.hash)}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors ${
                  isActive
                    ? 'border-l-[3px] border-science-blue bg-white pl-2 font-semibold text-science-blue shadow-2xs'
                    : 'text-ink hover:bg-bg-1 hover:text-science-blue'
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${isActive ? 'text-science-blue' : 'text-eyebrow'}`}
                />
                <span className="font-en truncate">{item.label}</span>
                {item.pill && (
                  <span
                    className={`ml-auto rounded px-1.5 py-0.5 font-en text-[9px] font-bold tracking-wider ${
                      isActive ? 'bg-science-blue text-white' : 'bg-bg-1 text-eyebrow'
                    }`}
                  >
                    {item.pill}
                  </span>
                )}
              </a>
            );
          })}
        </nav>
      </div>

      {/* Pull worker sources */}
      <div className="mt-6 px-3">
        <p className="font-en px-2.5 text-[10px] font-bold tracking-[0.14em] text-eyebrow uppercase">
          Worker Sources
        </p>
        <div className="mt-2 space-y-1">
          {[
            { name: 'Codex CLI', badge: 'CX', active: activeAgents.codex },
            { name: 'Claude Code', badge: 'CC', active: activeAgents.claude },
            { name: 'Demo worker', badge: 'DM', active: activeAgents.demo },
          ].map((source) => (
            <div
              key={source.name}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] text-ink"
            >
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-line bg-white font-mono text-[10px] font-bold text-science-blue">
                {source.badge}
              </span>
              <span className="font-en font-medium">{source.name}</span>
              <span
                className={`ml-auto h-2 w-2 rounded-full ${
                  source.active ? 'bg-st-green' : 'border border-navy-300 bg-white'
                }`}
                title={source.active ? 'Active in history' : 'Standby'}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1" />

      {/* Pull-based architecture note */}
      <div className="mx-3 mb-3 rounded-lg border border-line bg-white p-3">
        <div className="flex items-start gap-2.5">
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-eyebrow" />
          <div>
            <p className="font-en text-[11px] font-bold text-science-blue">Pull-based jobs</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
              エージェントはキューからジョブを取得。UIは実行イベントのみを購読します。
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2.5 border-t border-line bg-bg-1/60 px-4 py-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-science-blue text-white">
          <Terminal className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="font-en truncate text-[12px] font-semibold text-science-blue">
            Local instance
          </p>
          <p className="truncate font-mono text-[10px] text-ink-muted">Node 26 · Vite+ · React</p>
        </div>
      </div>
    </aside>
  );
}
