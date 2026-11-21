import { useRef, useState } from 'react';
import { FolderOpen, Upload } from 'lucide-react';
import type { ConditionResult } from '../../shared/conditions.ts';
import type { WorkflowJob } from '../../shared/types.ts';
import { ApiError, jsonRequest, request } from '../api.ts';
import { droppedFiles, selectFiles } from '../utils/dataset-upload.ts';
import type { UploadSelection } from '../utils/dataset-upload.ts';
import { ConditionEvidence } from './ConditionBuilder.tsx';

export function DatasetUpload({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (job: WorkflowJob) => void;
}) {
  const [selection, setSelection] = useState<UploadSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState<ConditionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  function selectionFailed(err: Error) {
    setError(selection ? `${err.message} 前の選択を保持しています。` : err.message);
  }
  function selected(files: File[], directory = false) {
    try {
      setSelection(selectFiles(files, directory));
      setError('');
      setEvidence(null);
    } catch (err) {
      selectionFailed(err as Error);
    }
  }
  async function upload() {
    if (!selection || busy) return;
    setBusy(true);
    setError('');
    setEvidence(null);
    let id: string | undefined;
    try {
      const session = await request<{ id: string }>(
        '/api/uploads',
        jsonRequest('POST', {
          projectId,
          name: selection.name,
          kind: selection.kind,
          files: selection.files.map(({ file, path }) => ({ path, bytes: file.size })),
        }),
      );
      id = session.id;
      for (let i = 0; i < selection.files.length; i++) {
        const { file, path } = selection.files[i];
        setProgress(`${i + 1} / ${selection.files.length} ファイルを転送中：${path}`);
        await request(`/api/uploads/${id}/files?${new URLSearchParams({ path })}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
      }
      setProgress('入力を検証してジョブを登録中…');
      const { job } = await request<{ job: WorkflowJob }>(
        `/api/uploads/${id}/commit`,
        jsonRequest('POST', {}),
      );
      onCreated(job);
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.result) setEvidence(err.result);
    } finally {
      if (id) await request(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => undefined);
      setBusy(false);
      setProgress('');
    }
  }
  return (
    <section
      className={`dataset-upload ${dragging ? 'is-dragging' : ''}`}
      aria-label="データセットの投入"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (busy) return;
        setError('');
        setBusy(true);
        setProgress('フォルダの内容を確認中…');
        void droppedFiles(event.dataTransfer)
          .then((value) => {
            setSelection(value);
            setError('');
            setEvidence(null);
          })
          .catch(selectionFailed)
          .finally(() => {
            setBusy(false);
            setProgress('');
          });
      }}
    >
      <div className="condition-toolbar">
        <Upload size={20} aria-hidden="true" />
        <h2>データをまとめて投入</h2>
        <button
          className="wf-secondary"
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          複数ファイルを選ぶ
        </button>
        <button
          className="wf-secondary"
          type="button"
          disabled={busy}
          onClick={() => folderRef.current?.click()}
        >
          <FolderOpen size={16} />
          フォルダを選ぶ
        </button>
      </div>
      <p className="wf-help">
        ここにフォルダや複数ファイルをドロップできます。選んだ内容を1つのジョブにまとめ、相対パスを保ちます。上限1000ファイル・1ファイル20MB・合計200MB。
      </p>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) selected([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        ref={(element) => {
          folderRef.current = element;
          if (element) element.webkitdirectory = true;
        }}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) selected([...e.target.files], true);
          e.target.value = '';
        }}
      />
      {selection && (
        <div className="upload-selection">
          <div className="wf-fields">
            <label>
              データセット名
              <input
                value={selection.name}
                disabled={busy}
                maxLength={120}
                onChange={(e) => setSelection({ ...selection, name: e.target.value })}
              />
            </label>
            <p>
              {selection.files.length} ファイル /{' '}
              {(
                selection.files.reduce((sum, item) => sum + item.file.size, 0) /
                1024 /
                1024
              ).toFixed(2)}{' '}
              MB → 1ジョブ
            </p>
          </div>
          <details>
            <summary>投入するファイルを確認</summary>
            <ul className="upload-file-list">
              {selection.files.map(({ file, path }) => (
                <li key={path}>
                  <span>{path}</span>
                  <small>{file.size.toLocaleString()} bytes</small>
                </li>
              ))}
            </ul>
          </details>
          <div className="condition-toolbar">
            <button
              className="wf-primary"
              type="button"
              disabled={busy || !selection.name.trim()}
              onClick={() => void upload()}
            >
              {busy ? '処理中…' : `${selection.files.length} ファイルを1ジョブとして投入`}
            </button>
            <button
              className="wf-secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setSelection(null);
                setError('');
                setEvidence(null);
              }}
            >
              選択を解除
            </button>
          </div>
        </div>
      )}
      {progress && <p role="status">{progress}</p>}
      {error && (
        <p className="condition-error" role="alert">
          {error}
        </p>
      )}
      {evidence && <ConditionEvidence result={evidence} />}
    </section>
  );
}
