import { useId } from 'react';
import { QUEUE_LIMITS, queueRange, validQueueValue, type QueueField } from '../../shared/queue.ts';
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
  const id = useId();
  const invalid = !validQueueValue(field, value);
  const range = queueRange(field);
  return (
    <div>
      <label>
        {label}（{range}）
        <NumberValue
          value={value}
          integer
          inputMode={QUEUE_LIMITS[field].min < 0 ? 'text' : 'numeric'}
          onChange={onChange}
          errorId={invalid ? id : undefined}
        />
      </label>
      {invalid && (
        <p id={id} className="condition-error">
          {range}の整数を入力してください。
        </p>
      )}
    </div>
  );
}
