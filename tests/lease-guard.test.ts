import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { LeaseGuard, leaseStopReserveMs } from '../shared/lease-guard.ts';
import { DEFAULT_PROCESS_GRACE_MS, PROCESS_KILL_FALLBACK_MS } from '../shared/process-runner.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const TTL = 30_000;
const HEARTBEAT = 7_500;
const RESERVE = DEFAULT_PROCESS_GRACE_MS + PROCESS_KILL_FALLBACK_MS;

it('reserves the process stop time, shrinking it only for very short leases', () => {
  expect(leaseStopReserveMs(TTL, HEARTBEAT)).toBe(RESERVE);
  expect(leaseStopReserveMs(1000, 250)).toBe(500);
  expect(leaseStopReserveMs(1000, 250, 100)).toBe(500);
  expect(leaseStopReserveMs(400, 250)).toBe(0);
});

it('measures the deadline from when the request was sent, not when it was answered', () => {
  const onStop = vi.fn();
  const sentAt = Date.now();
  const guard = new LeaseGuard({ sentAt, ttlMs: TTL, heartbeatMs: HEARTBEAT, onStop });
  // A slow response must not push the local deadline beyond the server's renewal.
  vi.advanceTimersByTime(3000);
  guard.renewed(sentAt + 1000);
  expect(guard.expiresAt).toBe(sentAt + 1000 + TTL);
  // An older heartbeat answered late never shortens or lengthens past a newer one.
  guard.renewed(sentAt);
  expect(guard.expiresAt).toBe(sentAt + 1000 + TTL);
  guard.dispose();
});

it('stops before server expiry even when heartbeats hang (watchdog)', () => {
  const onStop = vi.fn();
  const sentAt = Date.now();
  const guard = new LeaseGuard({ sentAt, ttlMs: TTL, heartbeatMs: HEARTBEAT, onStop });
  vi.advanceTimersByTime(TTL - RESERVE - 1);
  expect(onStop).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onStop).toHaveBeenCalledTimes(1);
  // The process tree has its whole TERM → KILL budget before the server expires the lease.
  expect(Date.now() + RESERVE).toBeLessThanOrEqual(sentAt + TTL);
  guard.dispose();
});

it('tolerates a transient failure but stops when the next heartbeat could not renew in time', () => {
  const onStop = vi.fn();
  const sentAt = Date.now();
  const guard = new LeaseGuard({ sentAt, ttlMs: TTL, heartbeatMs: HEARTBEAT, onStop });
  const failuresAt: number[] = [];
  // Fast failures (e.g. connection refused) on every heartbeat tick after the claim.
  for (let tick = 1; tick <= 4 && !onStop.mock.calls.length; tick++) {
    vi.setSystemTime(sentAt + tick * HEARTBEAT);
    guard.failed();
    failuresAt.push(Date.now());
  }
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(failuresAt.length).toBeGreaterThan(1);
  const stoppedAt = failuresAt.at(-1)!;
  // Stopping happens with the full process stop reserve left before server expiry.
  expect(stoppedAt + RESERVE).toBeLessThanOrEqual(sentAt + TTL);
  guard.dispose();
});

it('stops at once on an authoritative lease rejection', () => {
  for (const status of [404, 409]) {
    const onStop = vi.fn();
    const guard = new LeaseGuard({
      sentAt: Date.now(),
      ttlMs: TTL,
      heartbeatMs: HEARTBEAT,
      onStop,
    });
    guard.failed(status);
    expect(onStop).toHaveBeenCalledTimes(1);
    guard.failed(status);
    vi.advanceTimersByTime(TTL);
    expect(onStop).toHaveBeenCalledTimes(1);
  }
});

it('keeps a short lease alive while heartbeats succeed', () => {
  const onStop = vi.fn();
  const ttl = 1000;
  const heartbeat = 250;
  const guard = new LeaseGuard({ sentAt: Date.now(), ttlMs: ttl, heartbeatMs: heartbeat, onStop });
  for (let i = 0; i < 20; i++) {
    vi.advanceTimersByTime(heartbeat);
    guard.renewed(Date.now());
  }
  expect(onStop).not.toHaveBeenCalled();
  guard.dispose();
  vi.advanceTimersByTime(ttl * 2);
  expect(onStop).not.toHaveBeenCalled();
});
