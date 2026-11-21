export interface InboxObservation {
  signature: string;
  seenAt: number;
  ingested: boolean;
  /** Set once the registered-job lookup ran for this exact signature. */
  matchChecked?: boolean;
  failedRevision?: string;
  failedMessage?: string;
}

/** Start a fresh observation whenever the inventory signature changes. */
export function observeInput(
  observed: Map<string, InboxObservation>,
  key: string,
  signature: string,
  now = Date.now(),
): InboxObservation {
  const previous = observed.get(key);
  if (previous?.signature === signature) return previous;
  const next: InboxObservation = { signature, seenAt: now, ingested: false };
  observed.set(key, next);
  return next;
}

/**
 * Run an expensive lookup (such as re-hashing a dataset) at most once per signature.
 * Repeated scans of unchanged input reuse the negative result instead of hashing again.
 */
export function findRegisteredOnce<T>(
  observation: InboxObservation,
  lookup: () => T | undefined,
): T | undefined {
  if (observation.matchChecked) return undefined;
  observation.matchChecked = true;
  return lookup();
}
