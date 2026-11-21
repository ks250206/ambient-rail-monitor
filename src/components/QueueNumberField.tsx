import { useId } from 'react';
import { QUEUE_LIMITS, queueRange, validQueueValue, type QueueField } from '../../shared/queue.ts';
import { useI18n } from '../i18n.ts';
import { NumberValue } from './NumberValue.tsx';

export function QueueNumberField({
  field,
  label,
  value,
  onChange,
}: {
  field: QueueField;
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const { locale, pick } = useI18n();
  const id = useId();
  const invalid = !validQueueValue(field, value);
  const { min, max } = QUEUE_LIMITS[field];
  const range = locale === 'en' ? `${min}–${max}` : queueRange(field);
  return (
    <div>
      <label>
        {locale === 'en' ? `${label} (${range})` : `${label}（${range}）`}
        <NumberValue
          value={value}
          integer
          inputMode={min < 0 ? 'text' : 'numeric'}
          onChange={onChange}
          errorId={invalid ? id : undefined}
        />
      </label>
      {invalid && (
        <p id={id} className="condition-error">
          {pick(`${range}の整数を入力してください。`, `Enter an integer between ${range}.`)}
        </p>
      )}
    </div>
  );
}
