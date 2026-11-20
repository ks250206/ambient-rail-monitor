import { useEffect, useRef, useState } from 'react';

/** Preserve intermediate edits such as "-" and "1e-" without silently making them zero. */
export function NumberValue({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const last = useRef(value);
  useEffect(() => {
    if (!Object.is(last.current, value)) {
      last.current = value;
      setDraft(String(value));
    }
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-invalid={!Number.isFinite(value)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const parsed =
          text.trim() && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())
            ? Number(text)
            : NaN;
        last.current = parsed;
        onChange(parsed);
      }}
    />
  );
}
