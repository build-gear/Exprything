import { summarize } from './activity.ts';

type Input = Record<string, unknown>;

/** A tool call as the sidebar names it: Exprything's own tools by their short name, others as the agent names them. */
export function describeTool(name: string, input: Input): { name: string; summary?: string } {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? [];
  if (!server) return { name, summary: summarize(name, input) };
  if (server !== 'exprything') return { name: `${server}: ${tool}` };
  return { name: tool, summary: canvasToolSummary(tool, input) };
}

/** What one of Exprything's MCP tools is doing, from its arguments. */
export function canvasToolSummary(tool: string, input: Input): string | undefined {
  const canvas = typeof input.canvas === 'string' ? input.canvas : undefined;
  if (tool !== 'canvas_apply') return canvas;
  const ops = Array.isArray(input.ops) ? input.ops.length : 0;
  return `${input.dryRun ? 'dry run, ' : ''}${ops} change${ops === 1 ? '' : 's'}${canvas ? ` on ${canvas}` : ''}`;
}

/** The last line of a process's stderr worth showing, without terminal colours. */
export function lastLine(stderr: string): string | undefined {
  return stderr.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((s) => s.trim()).filter(Boolean).at(-1);
}
