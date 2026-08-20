import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SessionRow {
  key: string;
  agent: string;
  sessionId: string;
  cwd: string;
  channel: string;
  threadTs: string | null;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * Persistent thread → ACP session map. Survives restarts so a thread can be
 * re-attached via `session/load` instead of starting over.
 */
export class SessionStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread_ts TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_thread ON sessions(channel, thread_ts);
    `);
  }

  get(key: string): SessionRow | undefined {
    const r = this.db
      .prepare(
        `SELECT key, agent, session_id AS sessionId, cwd, channel, thread_ts AS threadTs,
                created_at AS createdAt, last_used_at AS lastUsedAt FROM sessions WHERE key = ?`,
      )
      .get(key) as SessionRow | undefined;
    return r;
  }

  put(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (key, agent, session_id, cwd, channel, thread_ts, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET agent=excluded.agent, session_id=excluded.session_id,
           cwd=excluded.cwd, last_used_at=excluded.last_used_at`,
      )
      .run(row.key, row.agent, row.sessionId, row.cwd, row.channel, row.threadTs, row.createdAt, row.lastUsedAt);
  }

  touch(key: string, at = Date.now()): void {
    this.db.prepare(`UPDATE sessions SET last_used_at = ? WHERE key = ?`).run(at, key);
  }

  delete(key: string): boolean {
    const r = this.db.prepare(`DELETE FROM sessions WHERE key = ?`).run(key);
    return Number(r.changes) > 0;
  }

  /** True if we have ever held a session for this Slack thread. */
  hasThread(channel: string, threadTs: string): boolean {
    const r = this.db
      .prepare(`SELECT 1 FROM sessions WHERE channel = ? AND thread_ts = ? LIMIT 1`)
      .get(channel, threadTs);
    return !!r;
  }

  close(): void {
    this.db.close();
  }
}
