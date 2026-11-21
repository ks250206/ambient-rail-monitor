import { AlertTriangle, Info, MessageSquare, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n.ts';

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

export interface AlertOptions {
  title: string;
  message: string;
  detail?: string;
  okLabel?: string;
  tone?: 'default' | 'danger';
}

export interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
}

type DialogRequest =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'alert'; options: AlertOptions; resolve: () => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

const queue: DialogRequest[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getActiveDialog(): DialogRequest | null {
  return queue[0] ?? null;
}

function shiftDialog() {
  queue.shift();
  notify();
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ kind: 'confirm', options, resolve });
    notify();
  });
}

export function alertDialog(options: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    queue.push({ kind: 'alert', options, resolve });
    notify();
  });
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ kind: 'prompt', options, resolve });
    notify();
  });
}

/** Clears queued dialogs (intended for test cleanup). */
export function resetDialogs() {
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.kind === 'confirm') item.resolve(false);
    else if (item.kind === 'alert') item.resolve();
    else item.resolve(null);
  }
  notify();
}

export function DialogHost() {
  const active = useSyncExternalStore(subscribe, getActiveDialog, () => null);
  const { pick } = useI18n();
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    if (active.kind === 'prompt') {
      setInputValue(active.options.defaultValue ?? '');
      setInputError(null);
    }
    const timer = window.setTimeout(() => {
      if (active.kind === 'prompt') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (active.kind === 'confirm' && active.options.tone === 'danger') {
        cancelRef.current?.focus();
      } else {
        primaryRef.current?.focus();
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      previousFocusRef.current?.focus?.();
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (active.kind === 'confirm') active.resolve(false);
        else if (active.kind === 'alert') active.resolve();
        else active.resolve(null);
        shiftDialog();
        return;
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active]);

  if (!active || typeof document === 'undefined') return null;

  const tone = active.kind === 'prompt' ? 'default' : (active.options.tone ?? 'default');
  const isDanger = tone === 'danger';

  function dismiss() {
    if (!active) return;
    if (active.kind === 'confirm') active.resolve(false);
    else if (active.kind === 'alert') active.resolve();
    else active.resolve(null);
    shiftDialog();
  }

  function submitConfirm() {
    if (!active) return;
    if (active.kind === 'confirm') {
      active.resolve(true);
      shiftDialog();
    } else if (active.kind === 'alert') {
      active.resolve();
      shiftDialog();
    } else {
      const err = active.options.validate?.(inputValue) ?? null;
      if (err) {
        setInputError(err);
        inputRef.current?.focus();
        return;
      }
      active.resolve(inputValue);
      shiftDialog();
    }
  }

  const icon =
    active.kind === 'prompt' ? (
      <MessageSquare size={20} aria-hidden="true" className="text-science-blue" />
    ) : isDanger ? (
      <AlertTriangle size={20} aria-hidden="true" className="text-st-red" />
    ) : (
      <Info size={20} aria-hidden="true" className="text-science-blue" />
    );

  return createPortal(
    <div
      className="rf-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={dialogRef}
        role={active.kind === 'alert' || isDanger ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={`rf-dialog-panel ${isDanger ? 'is-danger' : ''}`}
      >
        <div className="rf-dialog-header">
          <div className="flex items-center gap-2.5">
            {icon}
            <h2 id={titleId} className="text-base font-bold text-science-blue">
              {active.options.title}
            </h2>
          </div>
          <button
            type="button"
            aria-label={pick('閉じる', 'Close')}
            onClick={dismiss}
            className="rf-dialog-close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div id={descId} className="rf-dialog-body">
          {active.options.message && (
            <p className="text-sm leading-relaxed whitespace-pre-line text-ink">
              {active.options.message}
            </p>
          )}
          {'detail' in active.options && active.options.detail && (
            <div className="mt-3 rounded border border-line bg-bg-2 px-3 py-2 text-xs leading-relaxed whitespace-pre-line text-ink-muted">
              {active.options.detail}
            </div>
          )}
          {active.kind === 'prompt' && (
            <form
              className="mt-3"
              onSubmit={(event) => {
                event.preventDefault();
                submitConfirm();
              }}
            >
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                placeholder={active.options.placeholder}
                aria-invalid={inputError ? true : undefined}
                onChange={(event) => {
                  setInputValue(event.target.value);
                  if (inputError) setInputError(null);
                }}
                className="w-full rounded border border-navy-400 bg-white px-3 py-2 text-sm text-ink focus:border-science-blue focus:outline-none"
              />
              {inputError && (
                <p role="alert" className="mt-1.5 text-xs font-semibold text-st-red-dark">
                  {inputError}
                </p>
              )}
            </form>
          )}
        </div>

        <div className="rf-dialog-actions">
          {active.kind !== 'alert' && (
            <button ref={cancelRef} type="button" onClick={dismiss} className="wf-secondary">
              {active.options.cancelLabel ?? pick('キャンセル', 'Cancel')}
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            onClick={submitConfirm}
            className={isDanger ? 'rf-dialog-danger-btn' : 'wf-primary'}
          >
            {active.kind === 'alert'
              ? (active.options.okLabel ?? pick('OK', 'OK'))
              : (active.options.confirmLabel ??
                (isDanger ? pick('実行する', 'Proceed') : pick('続行', 'Confirm')))}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
