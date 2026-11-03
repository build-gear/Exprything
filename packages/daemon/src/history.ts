import { DatabaseSync } from 'node:sqlite';

/** Samples of each source's value over time — this is what turns "current value" APIs into trends. */
export class History {
  private db: DatabaseSync;
  private lastWrite = new Map<string, { ts: number; json: string }>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples (source TEXT NOT NULL, ts INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_source_ts ON samples (source, ts);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /**
   * Record a sample. Unchanged values are only re-recorded once an hour so long-running
   * sources do not bloat the database; charts treat the gaps as "value held".
   */
  record(source: string, value: unknown, ts = Date.now()): void {
    const json = JSON.stringify(value ?? null);
    const last = this.lastWrite.get(source) ?? this.loadLast(source);
    if (last && last.json === json && ts - last.ts < 3_600_000) return;
    this.db.prepare('INSERT INTO samples (source, ts, value) VALUES (?, ?, ?)').run(source, ts, json);
    this.lastWrite.set(source, { ts, json });
  }

  latest(source: string): { ts: number; value: unknown } | undefined {
    const row = this.db
      .prepare('SELECT ts, value FROM samples WHERE source = ? ORDER BY ts DESC LIMIT 1')
      .get(source) as { ts: number; value: string } | undefined;
    return row && { ts: row.ts, value: JSON.parse(row.value) };
  }

  series(source: string, limit = 500): { ts: string; value: unknown }[] {
    const rows = this.db
      .prepare('SELECT ts, value FROM samples WHERE source = ? ORDER BY ts DESC LIMIT ?')
      .all(source, limit) as { ts: number; value: string }[];
    return rows.reverse().map((r) => ({ ts: new Date(r.ts).toISOString(), value: JSON.parse(r.value) }));
  }

  prune(source: string, keepMs: number): void {
    this.db.prepare('DELETE FROM samples WHERE source = ? AND ts < ?').run(source, Date.now() - keepMs);
  }

  drop(source: string): void {
    this.db.prepare('DELETE FROM samples WHERE source = ?').run(source);
    this.lastWrite.delete(source);
  }

  getKv<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setKv(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  private loadLast(source: string) {
    const l = this.latest(source);
    return l && { ts: l.ts, json: JSON.stringify(l.value) };
  }
}
