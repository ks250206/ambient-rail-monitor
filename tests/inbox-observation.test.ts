import { expect, it } from 'vite-plus/test';
import { findRegisteredOnce, observeInput } from '../shared/inbox-observation.ts';
import type { InboxObservation } from '../shared/inbox-observation.ts';

it('runs the registered-dataset lookup once per inventory signature', () => {
  const observed = new Map<string, InboxObservation>();
  let lookups = 0;
  const lookup = () => {
    lookups++;
    return undefined;
  };
  for (let scan = 0; scan < 5; scan++) {
    const observation = observeInput(observed, 'inbox::dataset', 'sig-a', 1000 + scan);
    expect(observation.seenAt).toBe(1000);
    expect(findRegisteredOnce(observation, lookup)).toBeUndefined();
  }
  expect(lookups).toBe(1);

  // A changed inventory is a new observation and must be compared again.
  const changed = observeInput(observed, 'inbox::dataset', 'sig-b', 2000);
  expect(changed).toMatchObject({ seenAt: 2000, ingested: false });
  expect(findRegisteredOnce(changed, () => 'run_12345678')).toBe('run_12345678');
  expect(findRegisteredOnce(changed, lookup)).toBeUndefined();
  expect(lookups).toBe(1);
});
