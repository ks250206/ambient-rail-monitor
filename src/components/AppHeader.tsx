import { clock } from '../utils/workflow.ts';

interface AppHeaderProps {
  currentPage: 'monitor' | 'workflow';
  connection: 'connecting' | 'online' | 'reconnecting';
  nowMs: number;
}

export function AppHeader({ currentPage, connection, nowMs }: AppHeaderProps) {
  return (
    <header className="border-t-4 border-science-blue border-b border-b-line bg-white">
      <div className="page-width flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:gap-x-6">
          <div className="flex items-baseline gap-3 text-science-blue sm:gap-5">
            <span lang="en" className="font-en text-xl font-semibold sm:text-2xl">
              Science Tokyo
            </span>
            <a
              href="/"
              className="border-l border-science-sub pl-3 font-en text-sm font-bold tracking-wide sm:pl-5"
            >
              RAILFLOW
            </a>
          </div>

          <nav aria-label="ページ切替" className="flex items-center gap-1">
            <a
              href="/workflow"
              aria-current={currentPage === 'workflow' ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                currentPage === 'workflow'
                  ? 'bg-science-blue text-white'
                  : 'text-science-blue hover:bg-bg-2'
              }`}
            >
              ワークフロー定義
            </a>
            <a
              href="/"
              aria-current={currentPage === 'monitor' ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                currentPage === 'monitor'
                  ? 'bg-science-blue text-white'
                  : 'text-science-blue hover:bg-bg-2'
              }`}
            >
              実行モニター
            </a>
          </nav>
        </div>

        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${connection === 'online' ? 'bg-st-green' : 'bg-st-orange'}`}
          />
          <span>
            {connection === 'online'
              ? 'オンライン'
              : connection === 'connecting'
                ? '接続を開始しています'
                : '再接続中'}
          </span>
          <time className="hidden border-l border-line pl-3 font-mono sm:inline">
            {clock(new Date(nowMs).toISOString())}
          </time>
        </div>
      </div>
    </header>
  );
}
