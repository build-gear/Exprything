import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApplyRequest, Id, type ApplyRequestInput } from '@exprything/schema';
import type { ExpClient } from '@exprything/client';

const CanvasArg = z.object({ canvas: Id.default('main') });
const SelectionArgs = z.object({ canvas: Id.optional().describe('leave out for the canvas the person used last') });
const PushArgs = z.object({
  source: Id,
  data: z.unknown().describe('item or array of items to add'),
  mode: z.enum(['append', 'replace']).default('append'),
});
const Empty = z.object({});

/** What the agent reads about this server before it looks at any tool (Claude Code's tool search, Codex's tool namespace). */
const instructions = `Exprything is a live canvas the person keeps open (in their browser or the Exprything app). Use it when they want to see something that should stay up to date: a chart, table, KPI, log or dashboard about their code, services, data or coding agents.
You draw it once and Exprything keeps it fresh on its own, without calling you again. So each widget (node) reads a source that is a recipe: HOW to get the data (an exec command, a file, pushed items, agent activity) and how often (refresh.every), shaped by a JSONata transform. Never put a value you computed yourself into a static source; it would never change.
How to draw:
1. catalog_get once: the widget types, their data contracts, and the source and style schemas.
2. canvas_apply with dryRun=true, check every sample, fix what is wrong, then canvas_apply for real.
3. exec sources run only after the person approves them on the canvas (or with \`exp approve <id>\`); tell them.
4. Give them the canvas URL (canvas_open).
Later, canvas_read and source_status show what is on a canvas and what broke; fix broken recipes with canvas_apply (the same ids update in place). When the person says "this" or "these", call canvas_selection for what they selected.
While you work the person sees your cursor on the canvas. A dry run reserves what it touches, so they cannot edit it until you apply for real or about 20 seconds pass; apply soon after a dry run.
Agent activity: when Claude Code or Codex hooks are connected (\`exp connect <agent> --activity\`), sources of kind "agent" read what agents did (events) or the state of each session (view "sessions"); the "agent-activity" canvas shows them.`;

const tools = {
  catalog_get: {
    description:
      'Read this first. Returns the authoring guide, every widget type (props JSON schema, data contract, example) and the source/op schema.',
    args: Empty,
    annotations: { title: 'Read the widget catalog', readOnlyHint: true, openWorldHint: false },
  },
  canvas_apply: {
    description:
      'Create or update sources (self-refreshing data recipes) and nodes (views) on a canvas in one atomic batch. ' +
      'Exprything keeps nodes fresh on its own afterwards, with no further AI calls, so write HOW to compute data ' +
      '(exec command, file, push) with refresh.every and a JSONata transform, not hardcoded results. ' +
      'Always call with dryRun=true first and check the samples. Ids are stable upsert keys. ' +
      'Widgets can be styled like Excalidraw shapes ("style" on a node or the whole canvas; see catalog_get).',
    args: ApplyRequest,
    // Ids are upsert keys, so the same request twice leaves the same canvas.
    annotations: { title: 'Draw on a canvas', readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  canvas_read: {
    description: 'Read a canvas: nodes, their current data, and each source\'s freshness/error state.',
    args: CanvasArg,
    annotations: { title: 'Read a canvas', readOnlyHint: true, openWorldHint: false },
  },
  canvas_open: {
    description: 'Get the URL of a canvas to show the user, plus sources awaiting approval and sources needing repair.',
    args: CanvasArg,
    annotations: { title: 'Get a canvas URL', readOnlyHint: true, openWorldHint: false },
  },
  canvas_selection: {
    description:
      'What the person has selected on a canvas open in their browser. Call it when they say "this" or "these". ' +
      'Returns widget nodes (ids you can update with canvas_apply) and things they drew (type, text, position, ' +
      'what an arrow connects; a widget end reads node:<id>). open=false means no browser has the canvas open.',
    args: SelectionArgs,
    annotations: { title: 'Read what the person selected', readOnlyHint: true, openWorldHint: false },
  },
  source_push: {
    description: 'Push data into a push-kind source (e.g. progress or log lines from a long task).',
    args: PushArgs,
    annotations: { title: 'Push data to a source', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  source_status: {
    description:
      'Health of every source. "repairs" lists broken recipes with the error and last good value: fix them with canvas_apply.',
    args: Empty,
    annotations: { title: 'Check source health', readOnlyHint: true, openWorldHint: false },
  },
} satisfies Record<string, { description: string; args: z.ZodType; annotations: ToolAnnotations }>;

type ToolName = keyof typeof tools;

export async function runMcpServer(client: ExpClient): Promise<void> {
  const server = new Server({ name: 'exprything', version: '0.0.1' }, { capabilities: { tools: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.args, { io: 'input', unrepresentable: 'any' }) as { type: 'object' },
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // One server runs per agent session, so this is how the canvas tells two sessions' cursors apart.
    client.agent ??= { id: randomUUID(), name: agentName(server.getClientVersion()) };
    const name = req.params.name as ToolName;
    const tool = tools[name];
    if (!tool) return error(`unknown tool: ${req.params.name}`);
    const parsed = tool.args.safeParse(req.params.arguments ?? {});
    if (!parsed.success) return error(z.prettifyError(parsed.error));
    try {
      return ok(await call(client, name, parsed.data));
    } catch (e) {
      return error((e as Error).message);
    }
  });

  await server.connect(new StdioServerTransport());
}

/** The name a person knows the agent by, from what its MCP client reports ("claude-code", "codex-mcp-client"). */
function agentName(client?: { name: string; title?: string }): string {
  const name = client?.name ?? '';
  if (/^claude-code/i.test(name)) return 'Claude Code';
  if (/^codex/i.test(name)) return 'Codex';
  // It travels in a header.
  return (client?.title ?? name).replace(/[^\x20-\x7e]/g, '').slice(0, 40) || 'Agent';
}

async function call(client: ExpClient, name: ToolName, args: any): Promise<unknown> {
  switch (name) {
    case 'catalog_get':
      return client.catalog();
    case 'canvas_apply': {
      if (args.dryRun) return client.apply({ ...args, dryRun: true });
      const res = await client.apply({ ...(args as ApplyRequestInput), dryRun: false });
      const url = client.canvasUrl(res.canvas);
      if (res.needsApproval.length === 0) return { ...res, url };
      return {
        ...res,
        url,
        note: `Ask the user to approve ${res.needsApproval.join(', ')} on the canvas (or run \`exp approve <id>\`) so it runs on schedule.`,
      };
    }
    case 'canvas_read':
      return client.canvas(args.canvas);
    case 'canvas_open': {
      const status = await client.status();
      return { url: client.canvasUrl(args.canvas), canvases: await client.canvases(), needsApproval: status.needsApproval, repairs: status.repairs };
    }
    case 'canvas_selection':
      return client.selection(args.canvas);
    case 'source_push':
      return client.push(args.source, args.data, args.mode);
    case 'source_status':
      return client.status();
  }
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
