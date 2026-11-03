import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApplyRequest, Id, type ApplyRequestInput } from '@exprything/schema';
import type { ExpClient } from '@exprything/client';

const CanvasArg = z.object({ canvas: Id.default('main') });
const PushArgs = z.object({
  source: Id,
  data: z.unknown().describe('item or array of items to add'),
  mode: z.enum(['append', 'replace']).default('append'),
});
const Empty = z.object({});

const tools = {
  catalog_get: {
    description:
      'Read this first. Returns the authoring guide, every widget type (props JSON schema, data contract, example) and the source/op schema.',
    args: Empty,
  },
  canvas_apply: {
    description:
      'Create or update sources (self-refreshing data recipes) and nodes (views) on a canvas in one atomic batch. ' +
      'Exprything keeps nodes fresh on its own afterwards, with no further AI calls, so write HOW to compute data ' +
      '(exec command, file, push) with refresh.every and a JSONata transform, not hardcoded results. ' +
      'Always call with dryRun=true first and check the samples. Ids are stable upsert keys.',
    args: ApplyRequest,
  },
  canvas_read: {
    description: 'Read a canvas: nodes, their current data, and each source\'s freshness/error state.',
    args: CanvasArg,
  },
  canvas_open: {
    description: 'Get the URL of a canvas to show the user, plus sources awaiting approval and sources needing repair.',
    args: CanvasArg,
  },
  source_push: {
    description: 'Push data into a push-kind source (e.g. progress or log lines from a long task).',
    args: PushArgs,
  },
  source_status: {
    description:
      'Health of every source. "repairs" lists broken recipes with the error and last good value: fix them with canvas_apply.',
    args: Empty,
  },
} satisfies Record<string, { description: string; args: z.ZodType }>;

type ToolName = keyof typeof tools;

export async function runMcpServer(client: ExpClient): Promise<void> {
  const server = new Server({ name: 'exprything', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.args, { io: 'input', unrepresentable: 'any' }) as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
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
