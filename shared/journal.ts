import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DatabaseSync as Database } from 'node:sqlite';
import type { WorkflowEvent } from './types.ts';

export interface Lease {
  jobId: string;
  token: string;
  worker: string;
  expiresAt: number;
  heartbeatAt: number;
}

/** One server owns a home. SQLite is authoritative; JSONL remains a repairable export. */
export class Journal {
  private db: Database;
  private jsonl: string;

  constructor(file: string, jsonl: string) {
    this.jsonl = jsonl;
    this.db = new Database(file, { timeout: 1000 });
    try {
      // An OS-held exclusive lock also prevents two servers using stale in-memory projections.
      this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases(jobId TEXT PRIMARY KEY, token TEXT NOT NULL,
          worker TEXT NOT NULL, expiresAt INTEGER NOT NULL, heartbeatAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, token TEXT NOT NULL, sequence INTEGER NOT NULL);
        COMMIT;`);
    } catch (error) {
      this.db.close();
      throw new Error('RAILFLOW_HOME is already in use or its journal is unavailable.', {
        cause: error,
      });
    }
    if (!this.setting('jsonlImported')) {
      const rows: WorkflowEvent[] = [];
      if (existsSync(jsonl)) {
        for (const line of readFileSync(jsonl, 'utf8').split(/\r?\n/).filter(Boolean)) {
          try {
            const event = JSON.parse(line) as WorkflowEvent;
            if (
              !Number.isSafeInteger(event.sequence) ||
              event.sequence < 1 ||
              !event.type ||
              !event.jobId
            )
              throw new Error('Invalid event');
            rows.push(event);
          } catch {
            console.error('Skipping invalid legacy event during journal migration.');
          }
        }
      }
      this.transaction(() => {
        const insert = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?)');
        for (const event of rows) insert.run(event.sequence, JSON.stringify(event));
        this.setSetting('jsonlImported', true);
      });
    }
    const temporary = jsonl + '.tmp';
    writeFileSync(
      temporary,
      this.events()
        .map((e) => JSON.stringify(e) + '\n')
        .join(''),
    );
    renameSync(temporary, jsonl);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  events(): WorkflowEvent[] {
    return this.db
      .prepare('SELECT body FROM events ORDER BY sequence')
      .all()
      .map((row) => JSON.parse(String(row.body)) as WorkflowEvent);
  }

  append(
    event: WorkflowEvent,
    lease?: Lease | null,
    request?: { id: string; token: string },
  ): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO events VALUES (?, ?)')
        .run(event.sequence, JSON.stringify(event));
      if (request)
        this.db
          .prepare('INSERT INTO requests VALUES (?, ?, ?)')
          .run(request.id, request.token, event.sequence);
      if (lease)
        this.db
          .prepare('INSERT INTO leases VALUES (?, ?, ?, ?, ?)')
          .run(lease.jobId, lease.token, lease.worker, lease.expiresAt, lease.heartbeatAt);
      else if (lease === null) this.db.prepare('DELETE FROM leases WHERE jobId=?').run(event.jobId);
    });
    try {
      appendFileSync(this.jsonl, JSON.stringify(event) + '\n');
    } catch {
      console.error('JSONL export unavailable; committed events remain in SQLite.');
    }
  }

  response(id: string, token: string): WorkflowEvent | undefined {
    const row = this.db
      .prepare(
        'SELECT body FROM events JOIN requests USING(sequence) WHERE requests.id=? AND requests.token=?',
      )
      .get(id, token);
    return row ? (JSON.parse(String(row.body)) as WorkflowEvent) : undefined;
  }

  lease(jobId: string): Lease | undefined {
    return this.db.prepare('SELECT * FROM leases WHERE jobId=?').get(jobId) as unknown as
      | Lease
      | undefined;
  }

  leases(): Lease[] {
    return this.db.prepare('SELECT * FROM leases').all() as unknown as Lease[];
  }

  renew(jobId: string, token: string, now: number, ttl: number): boolean {
    return (
      this.db
        .prepare(
          'UPDATE leases SET heartbeatAt=?, expiresAt=? WHERE jobId=? AND token=? AND expiresAt>?',
        )
        .run(now, now + ttl, jobId, token, now).changes === 1
    );
  }

  setting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }
}
