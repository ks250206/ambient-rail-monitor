import { Download, ExternalLink } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';

import type { WorkflowJob } from '../../shared/types.ts';
import { bytes } from '../utils/workflow.ts';

interface ArtifactViewerProps {
  job: WorkflowJob | null;
  jobs: WorkflowJob[];
}

const modes = [
  { id: 'single', label: '単独表示' },
  { id: 'compare', label: 'ジョブ比較' },
] as const;
type ViewerMode = (typeof modes)[number]['id'];

export function ArtifactViewer({ job, jobs }: ArtifactViewerProps) {
  const [mode, setMode] = useState<ViewerMode>('single');
  const [comparisonId, setComparisonId] = useState('');
  const viewerId = useId();
  const candidates = jobs.filter(
    (other) => other.projectId === job?.projectId && other.id !== job.id,
  );
  const comparison = candidates.find((other) => other.id === comparisonId);
  function selectMode(next: ViewerMode) {
    if (next === 'compare' && mode !== 'compare' && !comparison) {
      const initial = candidates.find((other) => other.artifacts.length > 0) ?? candidates[0];
      setComparisonId(initial?.id ?? '');
    }
    setMode(next);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    let next: ViewerMode;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        next = mode === 'single' ? 'compare' : 'single';
        break;
      case 'Home':
        next = 'single';
        break;
      case 'End':
        next = 'compare';
        break;
      default:
        return;
    }
    event.preventDefault();
    selectMode(next);
    document.getElementById(`${viewerId}-${next}`)?.focus();
  }

  return (
    <div className="mt-3">
      <div role="tablist" aria-label="成果物閲覧" className="flex border-b border-line">
        {modes.map(({ id, label }) => (
          <button
            key={id}
            id={`${viewerId}-${id}`}
            type="button"
            role="tab"
            aria-selected={mode === id}
            aria-controls={`${viewerId}-panel`}
            tabIndex={mode === id ? 0 : -1}
            onClick={() => selectMode(id)}
            onKeyDown={navigate}
            className={`border-b-2 px-4 py-2.5 text-sm font-bold focus-visible:z-10 ${mode === id ? 'border-science-blue text-science-blue' : 'border-transparent text-ink-muted hover:bg-bg-2'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id={`${viewerId}-panel`}
        role="tabpanel"
        aria-labelledby={`${viewerId}-${mode}`}
        className="pt-4"
      >
        {!job ? (
          <p className="py-5 text-sm text-ink-muted">ジョブを選択すると成果物が表示されます。</p>
        ) : (
          <div className={`grid items-start gap-4 ${mode === 'compare' ? 'lg:grid-cols-2' : ''}`}>
            <ArtifactPane key={job.id} job={job} label="選択中のジョブ" />
            {mode === 'compare' && (
              <ArtifactPane
                job={comparison}
                label="比較するジョブ"
                choices={candidates}
                onChoose={setComparisonId}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ArtifactPaneProps {
  job: WorkflowJob | undefined;
  label: string;
  choices?: WorkflowJob[];
  onChoose?: (id: string) => void;
}

function ArtifactPane({ job, label, choices, onChoose }: ArtifactPaneProps) {
  const [selection, setSelection] = useState<{ jobId: string; file: string } | null>(null);
  const files = job?.artifacts ?? [];
  const artifact =
    files.find((item) => selection?.jobId === job?.id && selection?.file === item.name) ??
    files.find((item) => /\.html?$/i.test(item.name)) ??
    files[0];
  const isHtml = artifact && /\.html?$/i.test(artifact.name);
  const selectClass =
    'min-h-10 w-full min-w-0 rounded border border-navy-400 bg-white px-2.5 py-1.5 text-sm text-ink';

  return (
    <section
      aria-label={`${label}の成果物閲覧`}
      className="min-w-0 overflow-hidden rounded border border-line bg-white"
    >
      <div className="grid gap-3 border-b border-line bg-bg-2 px-4 py-3 sm:grid-cols-2">
        <div className="min-w-0">
          {choices && onChoose ? (
            <label className="grid gap-1">
              <span className="text-xs font-bold text-ink-muted">{label}</span>
              <select
                aria-label={label}
                className={selectClass}
                value={job?.id ?? ''}
                disabled={!choices.length}
                onChange={(e) => onChoose(e.target.value)}
              >
                {!job && <option value="">ジョブを選択</option>}
                {choices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.file} · {item.id}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            job && (
              <>
                <p className="text-xs font-bold text-ink-muted">{label}</p>
                <p className="mt-1 break-all text-sm font-bold text-science-blue">{job.file}</p>
                <p className="font-mono text-xs text-ink-muted">{job.id}</p>
              </>
            )
          )}
        </div>
        {artifact && job && (
          <label className="grid min-w-0 content-start gap-1">
            <span className="text-xs font-bold text-ink-muted">ファイル</span>
            <select
              className={selectClass}
              aria-label={`${label}の成果物`}
              value={artifact.name}
              onChange={(e) => setSelection({ jobId: job.id, file: e.target.value })}
            >
              {files.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!job ? (
        <p className="px-4 py-6 text-sm text-ink-muted">
          {choices?.length
            ? '比較するジョブを選択してください。'
            : 'このプロジェクトには比較できる別のジョブがありません。'}
        </p>
      ) : !artifact ? (
        <p className="px-4 py-6 text-sm text-ink-muted">
          このジョブには公開済みの成果物がありません。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
            <p className="min-w-0 break-all text-ink-muted">
              {artifact.name} · {bytes(artifact.bytes)}
            </p>
            {isHtml ? (
              <a
                href={artifact.uri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-bold text-science-blue hover:underline"
              >
                別タブで開く <ExternalLink size={13} />
              </a>
            ) : (
              <a
                href={artifact.uri}
                download={artifact.name}
                className="inline-flex items-center gap-1 font-bold text-science-blue hover:underline"
              >
                <Download size={14} />
                ダウンロード
              </a>
            )}
          </div>
          {isHtml && (
            <iframe
              key={artifact.uri}
              title={`${job.id} の ${artifact.name}`}
              src={artifact.uri}
              loading="lazy"
              sandbox=""
              referrerPolicy="no-referrer"
              className="block h-[min(65vh,44rem)] min-h-72 w-full border-t border-line bg-white"
            />
          )}
        </>
      )}
    </section>
  );
}
