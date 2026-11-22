import type { Condition, ConditionResult } from '../../shared/conditions.ts';
import type { DryRunResult } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';

const operators = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

function englishReason(condition: Condition | null, result: ConditionResult): string {
  if (!condition) return 'No additional trigger condition is configured.';
  const observed = JSON.stringify(result.actual);
  switch (condition.op) {
    case 'all':
      return 'All of the following conditions must pass.';
    case 'any':
      return 'At least one of the following conditions must pass.';
    case 'not':
      return 'The following condition is negated.';
    case 'file.exists':
      return `Files matching ${condition.pattern}: ${observed} (at least one required).`;
    case 'file.count':
    case 'file.bytes': {
      const quantity = condition.op === 'file.count' ? 'File count' : 'Total bytes';
      return `${quantity} for ${condition.pattern}: expected ${operators[condition.compare]} ${condition.value}, observed ${observed}.`;
    }
    case 'name.contains':
      return `Dataset name ${observed} ${result.status === 'pass' ? 'contains' : 'does not contain'} ${JSON.stringify(condition.value)}.`;
    case 'quiet':
      return result.actual === undefined
        ? 'The manual transfer is complete.'
        : `Quiet time: ${observed} seconds (at least ${condition.seconds} required).`;
    case 'file.contains':
    case 'json.value': {
      switch (result.errorCode) {
        case 'missing_file':
          return `File not found: ${condition.path}.`;
        case 'read_error':
          return `Could not read ${condition.path}.`;
        case 'text_too_large':
          return `${condition.path} exceeds the 2 MiB text limit.`;
        case 'invalid_json':
          return `${condition.path} is not valid JSON.`;
      }
      if (condition.op === 'file.contains')
        return `${condition.path} ${result.status === 'pass' ? 'contains' : 'does not contain'} ${JSON.stringify(condition.text)}.`;
      const field = `${condition.path} · ${condition.field}`;
      if (result.errorCode === 'missing_field') return `JSON field not found: ${field}.`;
      if (result.errorCode === 'wrong_type')
        return `${field}: expected a ${typeof condition.value} value.`;
      return `${field}: expected ${operators[condition.compare]} ${JSON.stringify(condition.value)}, observed ${observed}.`;
    }
  }
}

function EvidenceNode({ condition, result }: NonNullable<DryRunResult['trigger']['evidence']>) {
  const { pick } = useI18n();
  const children =
    condition?.op === 'not'
      ? [condition.child]
      : condition?.op === 'all' || condition?.op === 'any'
        ? condition.children
        : [];
  const japanese =
    !condition || children.length ? result.message : `${result.label}：${result.message}`;
  return (
    <>
      <p>{pick(japanese, englishReason(condition, result))}</p>
      {children.length > 0 && (
        <ul className="evidence-children">
          {children.map((child, index) => {
            const childResult = result.children?.[index];
            return (
              childResult && (
                <li key={index}>
                  <EvidenceNode condition={child} result={childResult} />
                </li>
              )
            );
          })}
        </ul>
      )}
    </>
  );
}

export function DryRunTriggerEvidence({ trigger }: { trigger: DryRunResult['trigger'] }) {
  const { pick } = useI18n();
  if (trigger.evidence) return <EvidenceNode {...trigger.evidence} />;
  // Older servers returned only a Japanese message. The status remains usable in both locales.
  return (
    <p>
      {pick(
        trigger.message,
        trigger.status === 'unknown'
          ? 'The watch folder’s quiet time was not recorded with this input.'
          : 'Detailed evidence is unavailable for this result.',
      )}
    </p>
  );
}
