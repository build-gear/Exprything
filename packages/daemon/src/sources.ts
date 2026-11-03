import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parseDuration, type Source, type SourceState } from '@exprything/schema';
import type { History } from './history.ts';
import { expandHome, paths, readJson, writeJsonAtomic } from './paths.ts';
import { runSource } from './runner.ts';

interface Runtime {
  state: SourceState;
  value?: unknown;
  timer?: NodeJS.Timeout;
  watcher?: FSWatcher;
  running?: boolean;
  rerun?: boolean;
}

interface SourcesFile {
  sources: Source[];
  /** exec source id -> hash of the command the user approved */
  approvals: Record<string, string>;
}

const DEFAULT_KEEP = '30d';
const MIN_INTERVAL_MS = 5_000;

/** Owns source recipes and runs them on schedule, with no AI involved. */
export class SourceManager {
  private specs = new Map<string, Source>();
  private approvals: Record<string, string>;
  private rt = new Map<string, Runtime>();

  constructor(private history: History, private onChange: (sourceId: string) => void) {
    const file = readJson<SourcesFile>(paths.sources, { sources: [], approvals: {} });
    for (const s of file.sources) this.specs.set(s.id, s);
    this.approvals = file.approvals;
  }

  start(): void {
    for (const src of this.specs.values()) this.boot(src, { resume: true });
  }

  stop(): void {
    for (const id of this.rt.keys()) this.halt(id);
  }

  list(): Source[] {
    return [...this.specs.values()];
  }

  get(id: string): Source | undefined {
    return this.specs.get(id);
  }

  needsApproval(src: Source): boolean {
    return src.kind === 'exec' && this.approvals[src.id] !== approvalHash(src);
  }

  /** Returns whether the stored spec changed. Re-applying an identical recipe is a no-op. */
  upsert(src: Source): boolean {
    const prev = this.specs.get(src.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(src)) return false;
    if (prev && prev.kind !== src.kind) this.history.drop(src.id);
    this.specs.set(src.id, src);
    this.persist();
    this.halt(src.id);
    this.boot(src, { resume: false });
    return true;
  }

  delete(id: string): void {
    this.halt(id);
    this.rt.delete(id);
    this.specs.delete(id);
    delete this.approvals[id];
    this.history.drop(id);
    this.persist();
  }

  approve(id: string): void {
    const src = this.specs.get(id);
    if (!src) throw new Error(`unknown source: ${id}`);
    if (src.kind !== 'exec') return;
    this.approvals[id] = approvalHash(src);
    this.persist();
    const r = this.rt.get(id);
    if (r?.state.status === 'needs_approval') {
      // No longer waiting on the person but on its run, which can take a while; say so now.
      r.state.status = 'pending';
      this.onChange(id);
    }
    void this.run(id);
  }

  async refresh(id: string): Promise<void> {
    if (!this.specs.has(id)) throw new Error(`unknown source: ${id}`);
    await this.run(id);
  }

  async push(id: string, data: unknown, mode: 'append' | 'replace'): Promise<void> {
    const src = this.specs.get(id);
    if (!src) throw new Error(`unknown source: ${id}`);
    if (src.kind !== 'push') throw new Error(`source ${id} is ${src.kind}, not push`);
    const items = Array.isArray(data) ? data : [data];
    const prev = mode === 'append' ? this.pushBuffer(id) : [];
    this.history.setKv(`push:${id}`, [...prev, ...items].slice(-src.maxItems));
    await this.run(id);
  }

  state(id: string): SourceState | undefined {
    const r = this.rt.get(id);
    const src = this.specs.get(id);
    if (!r || !src) return undefined;
    const every = src.refresh?.every ? parseDuration(src.refresh.every) : undefined;
    if (
      r.state.status === 'fresh' && every && r.state.lastSuccessAt &&
      Date.now() - Date.parse(r.state.lastSuccessAt) > every * 2 + 30_000
    ) {
      return { ...r.state, status: 'stale' };
    }
    return { ...r.state };
  }

  value(id: string): unknown {
    return this.rt.get(id)?.value;
  }

  series(id: string, limit?: number) {
    return this.history.series(id, limit);
  }

  // ---------- internals ----------

  private pushBuffer(id: string): unknown[] {
    return this.history.getKv<unknown[]>(`push:${id}`) ?? [];
  }

  private boot(src: Source, { resume }: { resume: boolean }): void {
    const r: Runtime = { state: { id: src.id, kind: src.kind, status: 'pending', failures: 0 } };
    this.rt.set(src.id, r);

    if (resume) {
      // Show the last known value immediately after a restart.
      const last = this.history.latest(src.id);
      if (last) {
        r.value = last.value;
        r.state.lastSuccessAt = new Date(last.ts).toISOString();
        r.state.status = 'fresh';
      }
    }

    if (this.needsApproval(src)) {
      r.state.status = 'needs_approval';
      this.onChange(src.id);
      return;
    }

    if (src.kind === 'file' && src.refresh?.onChange !== false) this.watchFile(src.path, src.id, r);

    const every = src.refresh?.every ? Math.max(parseDuration(src.refresh.every), MIN_INTERVAL_MS) : undefined;
    const sinceLast = r.state.lastSuccessAt ? Date.now() - Date.parse(r.state.lastSuccessAt) : Infinity;
    if (src.kind === 'push' && resume && r.value !== undefined) return;
    if (every && sinceLast < every) this.schedule(src.id, every - sinceLast);
    else void this.run(src.id);
  }

  private halt(id: string): void {
    const r = this.rt.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    r.watcher?.close();
  }

  private watchFile(path: string, id: string, r: Runtime): void {
    const full = expandHome(path);
    let debounce: NodeJS.Timeout | undefined;
    try {
      // Watch the directory so atomic rename-replacements of the file are still seen.
      r.watcher = watch(dirname(full), (_event, name) => {
        if (name && name !== basename(full)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => void this.run(id), 300);
      });
    } catch {
      // Directory missing: the run will surface the error.
    }
  }

  private schedule(id: string, delayMs: number): void {
    const r = this.rt.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    r.state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    r.timer = setTimeout(() => void this.run(id), delayMs);
    r.timer.unref?.();
  }

  private async run(id: string): Promise<void> {
    const src = this.specs.get(id);
    const r = this.rt.get(id);
    if (!src || !r) return;
    if (this.needsApproval(src)) {
      r.state.status = 'needs_approval';
      this.onChange(id);
      return;
    }
    if (r.running) {
      r.rerun = true;
      return;
    }
    r.running = true;
    clearTimeout(r.timer);
    r.state.nextRunAt = undefined;
    r.state.lastRunAt = new Date().toISOString();

    try {
      const value = await runSource(src, src.kind === 'push' ? this.pushBuffer(id) : undefined);
      if (this.specs.get(id) !== src) return; // replaced while running
      r.value = value;
      r.state = { ...r.state, status: 'fresh', failures: 0, lastError: undefined, lastSuccessAt: new Date().toISOString() };
      this.history.record(id, value);
      this.history.prune(id, parseDuration(src.history?.keep ?? DEFAULT_KEEP));
    } catch (e) {
      if (this.specs.get(id) !== src) return;
      r.state = { ...r.state, status: 'error', failures: r.state.failures + 1, lastError: (e as Error).message };
    } finally {
      r.running = false;
    }

    const every = src.refresh?.every ? Math.max(parseDuration(src.refresh.every), MIN_INTERVAL_MS) : undefined;
    if (every) {
      // Back off on failure: 5s, 10s, 20s ... capped at the normal interval.
      const delay = r.state.failures > 0 ? Math.min(every, MIN_INTERVAL_MS * 2 ** (r.state.failures - 1)) : every;
      this.schedule(id, delay);
    }
    this.onChange(id);

    if (r.rerun) {
      r.rerun = false;
      void this.run(id);
    }
  }

  private persist(): void {
    writeJsonAtomic(paths.sources, { sources: this.list(), approvals: this.approvals } satisfies SourcesFile);
  }
}

function approvalHash(src: Source): string {
  const spec = src.kind === 'exec' ? { cmd: src.cmd, cwd: src.cwd ?? null } : {};
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
}
