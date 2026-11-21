import { Download, ExternalLink } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';

import type { WorkflowJob } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { bytes } from '../utils/workflow.ts';
import { CustomSelect } from './CustomSelect.tsx';

interface ArtifactViewerProps {
  job: WorkflowJob | null;
  jobs: WorkflowJob[];
}

const modes = [
  { id: 'single', ja: '単独表示', en: 'Single view' },
  { id: 'compare', ja: 'ジョブ比較', en: 'Compare jobs' },
] as const;
type ViewerMode = (typeof modes)[number]['id'];

export function ArtifactViewer({ job, jobs }: ArtifactViewerProps) {
  const { pick } = useI18n();
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
      <div
        role="tablist"
        aria-label={pick('成果物', 'Artifacts')}
        className="flex border-b border-line"
      >
        {modes.map(({ id, ja, en }) => (
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
            {pick(ja, en)}
          </button>
        ))}
      </div>
      <div
        key={mode}
        id={`${viewerId}-panel`}
        role="tabpanel"
        aria-labelledby={`${viewerId}-${mode}`}
        className="panel-enter pt-4"
      >
        {!job ? (
          <p className="py-5 text-sm text-ink-muted">
            {pick(
              'ジョブを選択すると成果物が表示されます。',
              'Select a job to view its artifacts.',
            )}
          </p>
        ) : (
          <div className={`grid items-start gap-4 ${mode === 'compare' ? '@2xl:grid-cols-2' : ''}`}>
            <ArtifactPane key={job.id} job={job} label={pick('選択中のジョブ', 'Selected job')} />
            {mode === 'compare' && (
              <ArtifactPane
                job={comparison}
                label={pick('比較するジョブ', 'Compare with')}
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
  const { pick } = useI18n();
  const [selection, setSelection] = useState<{ jobId: string; file: string } | null>(null);
  const fileGroup = useId();
  const files = job?.artifacts ?? [];
  const artifact =
    files.find((item) => selection?.jobId === job?.id && selection?.file === item.name) ??
    files.find((item) => /\.html?$/i.test(item.name)) ??
    files[0];
  const isHtml = artifact && /\.html?$/i.test(artifact.name);

  return (
    <section
      aria-label={pick(`${label}の成果物`, `${label} artifacts`)}
      className="min-w-0 overflow-hidden rounded border border-line bg-white"
    >
      <div className="border-b border-line bg-bg-2 px-4 py-3">
        <div className="min-w-0">
          {choices && onChoose ? (
            <label className="grid gap-1">
              <span className="text-xs font-bold text-ink-muted">{label}</span>
              <CustomSelect
                ariaLabel={label}
                value={job?.id ?? ''}
                disabled={!choices.length}
                placeholder={pick('ジョブを選択', 'Select job')}
                options={choices.map((item) => ({
                  value: item.id,
                  label: `${item.file} · ${item.id}`,
                }))}
                onChange={onChoose}
              />
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
      </div>
      {job && (
        <fieldset className="min-w-0 px-4 pt-3">
          <legend className="float-left mb-2 w-full text-sm font-bold text-science-blue">
            {pick('成果物', 'Artifacts')}{' '}
            <span className="ml-1 tabular-nums">
              {pick(`${files.length}件`, `${files.length}`)}
            </span>
          </legend>
          {files.length > 0 && (
            <ul className="clear-both divide-y divide-line border-y border-line">
              {files.map((item) => (
                <li key={item.name}>
                  <label
                    className={`flex cursor-pointer items-center gap-3 px-2 py-2.5 text-sm hover:bg-bg-2 ${item.name === artifact?.name ? 'bg-bg-2 font-semibold text-science-blue' : ''}`}
                  >
                    <input
                      type="radio"
                      name={fileGroup}
                      value={item.name}
                      aria-label={item.name}
                      checked={item.name === artifact?.name}
                      onChange={() => setSelection({ jobId: job.id, file: item.name })}
                      className="shrink-0 accent-science-blue"
                    />
                    <span className="min-w-0 flex-1 break-all">{item.name}</span>
                    <span className="shrink-0 text-xs font-normal tabular-nums text-ink-muted">
                      {bytes(item.bytes)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
      {!job ? (
        <p className="px-4 py-6 text-sm text-ink-muted">
          {choices?.length
            ? pick('比較するジョブを選択してください。', 'Choose a job to compare.')
            : pick(
                'このプロジェクトには比較できる別のジョブがありません。',
                'No other jobs in this project are available to compare.',
              )}
        </p>
      ) : !artifact ? (
        <p className="px-4 py-6 text-sm text-ink-muted">
          {pick(
            'このジョブには公開済みの成果物がありません。',
            'This job has no published artifacts.',
          )}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
            <p className="min-w-0 break-all text-ink-muted">{artifact.name}</p>
            {isHtml ? (
              <a
                href={artifact.uri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-bold text-science-blue hover:underline"
              >
                {pick('別タブで開く', 'Open in new tab')} <ExternalLink size={13} />
              </a>
            ) : (
              <a
                href={artifact.uri}
                download={artifact.name}
                className="inline-flex items-center gap-1 font-bold text-science-blue hover:underline"
              >
                <Download size={14} />
                {pick('ダウンロード', 'Download')}
              </a>
            )}
          </div>
          {isHtml && (
            <iframe
              key={artifact.uri}
              title={pick(`${job.id} の ${artifact.name}`, `${artifact.name} from ${job.id}`)}
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
