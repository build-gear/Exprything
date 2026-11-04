import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homeDir, paths } from './paths.ts';

export interface ExpCommand {
  argv: string[];
  env: Record<string, string>;
}

/**
 * How to run the exp that is running now: the launcher inside Exprything.app, or this CLI on this
 * Node (a checkout, or the desktop app run from source).
 */
export function currentExp(): ExpCommand {
  const script = process.argv[1];
  if (process.env.ELECTRON_RUN_AS_NODE && existsSync(resolve(dirname(script), '../../MacOS/Exprything'))) {
    return { argv: [join(dirname(script), 'bin', 'exp')], env: {} };
  }
  const env: Record<string, string> = {};
  for (const k of ['ELECTRON_RUN_AS_NODE', 'EXPRYTHING_UI_DIST']) if (process.env[k]) env[k] = process.env[k]!;
  return { argv: [process.execPath, script], env };
}

/**
 * Agents run Exprything through <home>/bin/exp, which points at the install that wrote it last. Moving
 * the app, or switching to a checkout, rewrites only this file and never the agents' settings (Codex
 * would ask the person to trust changed hooks again).
 */
export function writeShim(target: ExpCommand = currentExp()): string {
  const env: Record<string, string> = { ...target.env, EXPRYTHING_HOME: homeDir() };
  if (process.env.EXPRYTHING_PORT) env.EXPRYTHING_PORT = process.env.EXPRYTHING_PORT;
  const body = [
    '#!/bin/sh',
    '# Written by Exprything: agents run exp through this file (its MCP server and activity hooks).',
    // Codex passes MCP servers only a few environment variables, so the ones this install needs are here.
    ...Object.entries(env).map(([k, v]) => `export ${k}="\${${k}:-${v.replace(/["\\$`]/g, '\\$&')}}"`),
    `exec ${target.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')} "$@"`,
    '',
  ].join('\n');
  const file = paths.shim;
  if (existsSync(file) && readFileSync(file, 'utf8') === body) return file;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o755 });
  renameSync(tmp, file);
  return file;
}
