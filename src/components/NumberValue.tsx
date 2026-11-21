import { useEffect, useRef, useState } from 'react';

function formatScaled(value: number, scale: number): string {
  if (!Number.isFinite(value)) return '';
  return String(value / scale);
}

/** Preserve intermediate edits such as "", "-" and "1e-" without silently making them zero. */
export function NumberValue({
  value,
  onChange,
  scale = 1,
  integer = false,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  scale?: number;
  integer?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatScaled(value, scale));
  const last = useRef(value);
  useEffect(() => {
    if (!Object.is(last.current, value)) {
      last.current = value;
      setDraft(formatScaled(value, scale));
    }
  }, [value, scale]);
  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={draft}
      disabled={disabled}
      aria-invalid={!Number.isFinite(value)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const trimmed = text.trim();
        const pattern = integer ? /^-?\d+$/ : /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
        const parsed = trimmed && pattern.test(trimmed) ? Number(trimmed) : NaN;
        const scaled = Number.isFinite(parsed)
          ? scale === 1
            ? parsed
            : Math.round(parsed * scale)
          : NaN;
        last.current = scaled;
        onChange(scaled);
      }}
    />
  );
}
