import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import jsonata from 'jsonata';
import type { Source } from '@exprything/schema';
import { expandHome } from './paths.ts';

type ParseMode = 'json' | 'jsonl' | 'csv' | 'lines' | 'text';

export async function applyTransform(expr: string | undefined, input: unknown): Promise<unknown> {
  if (!expr) return input;
  let compiled;
  try {
    compiled = jsonata(expr);
  } catch (e) {
    throw new Error(`transform syntax error: ${(e as Error).message}`);
  }
  try {
    return await compiled.evaluate(input);
  } catch (e) {
    throw new Error(`transform failed: ${(e as Error).message}`);
  }
}

export function parseOutput(raw: string, mode: ParseMode): unknown {
  switch (mode) {
    case 'text':
      return raw;
    case 'lines':
      return raw.split(/\r?\n/).filter((l) => l.length > 0);
    case 'json':
      return JSON.parse(raw);
    case 'jsonl':
      return raw
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    case 'csv':
      return parseCsv(raw);
  }
}

function parseCsv(raw: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && raw[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.length > 0));
  if (!header) return [];
  return body.map((r) =>
    Object.fromEntries(header.map((h, i) => {
      const v = r[i] ?? '';
      return [h, v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v];
    })),
  );
}

function runCommand(cmd: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd[0],
      cmd.slice(1),
      { cwd: cwd ? expandHome(cwd) : undefined, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim().split('\n').slice(-3).join(' | ');
          reject(new Error(`${cmd[0]} failed${err.code !== undefined ? ` (exit ${err.code})` : ''}: ${detail || err.message}`));
        } else resolve(stdout);
      },
    );
  });
}

/** Fetch and parse a source's raw data. Push sources pass their buffer in. */
export async function fetchRaw(source: Source, pushBuffer: unknown[] = []): Promise<unknown> {
  switch (source.kind) {
    case 'static':
      return source.data;
    case 'push':
      return pushBuffer;
    case 'exec':
      return parseOutput(await runCommand(source.cmd, source.cwd, source.timeoutMs), source.parse);
    case 'file':
      return parseOutput(await readFile(expandHome(source.path), 'utf8'), source.parse);
  }
}

export async function runSource(source: Source, pushBuffer?: unknown[]): Promise<unknown> {
  const raw = await fetchRaw(source, pushBuffer);
  const value = await applyTransform(source.transform, raw);
  // JSONata returns special sequence arrays; normalize to plain JSON.
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
