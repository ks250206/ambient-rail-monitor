import { DEFAULT_PROCESS_GRACE_MS, PROCESS_KILL_FALLBACK_MS } from './process-runner.ts';

/**
 * Time reserved before the server-side lease expiry for stopping the local process
 * tree (TERM → grace → KILL). Very short leases shrink the reserve so at least two
 * heartbeats still fit in one lease period.
 */
export function leaseStopReserveMs(
  ttlMs: number,
  heartbeatMs: number,
  graceMs = DEFAULT_PROCESS_GRACE_MS,
): number {
  return Math.max(0, Math.min(graceMs + PROCESS_KILL_FALLBACK_MS, ttlMs - 2 * heartbeatMs));
}

/**
 * Worker-side view of a lease. The deadline is always measured from when the
 * claim/heartbeat request was *sent*: the server renewed it no earlier than that,
 * so the local deadline never outlives the server's.
 */
export class LeaseGuard {
  readonly ttlMs: number;
  readonly heartbeatMs: number;
  readonly stopReserveMs: number;
  private deadline: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly onStop: (reason: string) => void;
  private readonly now: () => number;

  constructor(options: {
    sentAt: number;
    ttlMs: number;
    heartbeatMs: number;
    graceMs?: number;
    onStop: (reason: string) => void;
    now?: () => number;
  }) {
    this.ttlMs = options.ttlMs;
    this.heartbeatMs = options.heartbeatMs;
    this.stopReserveMs = leaseStopReserveMs(options.ttlMs, options.heartbeatMs, options.graceMs);
    this.onStop = options.onStop;
    this.now = options.now ?? Date.now;
    this.deadline = options.sentAt + options.ttlMs;
    this.arm();
  }

  /** Local time by which the process tree must have stopped. */
  get expiresAt(): number {
    return this.deadline;
  }

  /** A heartbeat sent at `sentAt` was accepted by the server. */
  renewed(sentAt: number, ttlMs = this.ttlMs): void {
    if (this.stopped) return;
    this.deadline = Math.max(this.deadline, sentAt + ttlMs);
    this.arm();
  }

  /**
   * A heartbeat failed. An authoritative rejection stops at once; a transient
   * failure stops if the next heartbeat could not renew in time to leave the
   * stop reserve before the server-side expiry.
   */
  failed(status?: number): void {
    if (this.stopped) return;
    if (status === 409 || status === 404) return this.stop('lease rejected');
    if (this.now() + this.heartbeatMs + this.stopReserveMs >= this.deadline)
      this.stop('heartbeat unavailable before lease expiry');
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private stop(reason: string): void {
    this.dispose();
    this.onStop(reason);
  }

  /** Watchdog: even a hung heartbeat cannot let the process outlive the lease. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, this.deadline - this.stopReserveMs - this.now());
    this.timer = setTimeout(() => this.stop('lease about to expire'), delay);
    this.timer.unref?.();
  }
}
