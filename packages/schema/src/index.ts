import { z } from 'zod';

export * from './catalog.ts';

// ---------- primitives ----------

export const Id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/, 'ids are 1-64 chars of [a-zA-Z0-9_.-]');

export const Duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'duration like "30s", "10m", "1h", "1d"');

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s);
  if (!m) throw new Error(`invalid duration: ${s}`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

export const ParseMode = z
  .enum(['json', 'jsonl', 'csv', 'lines', 'text'])
  .describe('how raw output is parsed before the transform runs');

// ---------- sources: recipes that refresh themselves ----------

const sourceBase = {
  id: Id,
  title: z.string().optional(),
  transform: z
    .string()
    .optional()
    .describe('JSONata expression applied to the parsed output. Must be deterministic.'),
  refresh: z
    .object({
      every: Duration.optional().describe('re-run interval, e.g. "10m"'),
      onChange: z.boolean().optional().describe('file sources: re-run when the file changes (default true)'),
    })
    .optional(),
  history: z
    .object({ keep: Duration.describe('how long samples are kept, default "30d"') })
    .optional(),
};

export const StaticSource = z.object({
  ...sourceBase,
  kind: z.literal('static'),
  data: z.unknown().describe('inline data. Use only for notes; prefer a recipe that can re-derive the value.'),
});

export const PushSource = z.object({
  ...sourceBase,
  kind: z.literal('push'),
  maxItems: z.number().int().positive().max(100_000).default(500),
});

export const ExecSource = z.object({
  ...sourceBase,
  kind: z.literal('exec'),
  cmd: z.array(z.string()).min(1).describe('argv, e.g. ["git","log","--pretty=%cI"]. Use ["sh","-c","..."] for pipes.'),
  cwd: z.string().optional().describe('working directory; ~ is expanded'),
  parse: ParseMode.default('text'),
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export const FileSource = z.object({
  ...sourceBase,
  kind: z.literal('file'),
  path: z.string().describe('absolute path or ~/...'),
  parse: ParseMode.default('json'),
});

export const Source = z.discriminatedUnion('kind', [StaticSource, PushSource, ExecSource, FileSource]);
export type Source = z.infer<typeof Source>;
export type SourceInput = z.input<typeof Source>;

export const SourceStatus = z.enum(['pending', 'fresh', 'stale', 'error', 'needs_approval']);
export type SourceStatus = z.infer<typeof SourceStatus>;

export interface SourceState {
  id: string;
  kind: Source['kind'];
  status: SourceStatus;
  lastRunAt?: string;
  lastSuccessAt?: string;
  nextRunAt?: string;
  lastError?: string;
  failures: number;
}

// ---------- style: the same vocabulary as Excalidraw shapes ----------

const Color = z
  .string()
  .regex(/^(transparent|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/, 'hex color like "#1971c2", or "transparent"');

/**
 * Widget style, named like Excalidraw element properties. Frame properties are drawn by Excalidraw
 * itself around the widget; fontFamily and strokeColor also restyle the widget's content.
 */
export const NodeStyle = z
  .object({
    strokeColor: Color.optional().describe('frame line, and the ink of titles, numbers and chart series'),
    backgroundColor: Color.optional().describe('frame fill'),
    fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']).optional().describe('how the frame and chart bars are filled'),
    strokeWidth: z.number().min(0.5).max(8).optional().describe('Excalidraw uses 1, 2 or 4'),
    strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
    roughness: z.number().min(0).max(2).optional().describe('0 architect (clean), 1 artist, 2 cartoonist. Above 0, bar and line charts are drawn by hand too'),
    roundness: z.enum(['sharp', 'round']).optional(),
    fontFamily: z.enum(['hand', 'normal', 'code']).optional().describe('hand = Excalifont handwriting, normal = Nunito, code = Comic Shanns'),
    opacity: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type NodeStyle = z.infer<typeof NodeStyle>;

// ---------- nodes: views over sources ----------

export const WidgetType = z.enum(['markdown', 'chart', 'table', 'stat', 'log']);
export type WidgetType = z.infer<typeof WidgetType>;

export const Layout = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    near: Id.optional().describe('place next to this node id'),
    side: z.enum(['right', 'below']).optional(),
  })
  .describe('express intent; omit to auto-place. Nodes the user moved are pinned and keep their position.');

export const CanvasNode = z.object({
  id: Id,
  type: WidgetType,
  title: z.string().optional(),
  source: Id.optional().describe('source id this node renders'),
  use: z
    .enum(['latest', 'history'])
    .default('latest')
    .describe('"latest" = current value; "history" = [{ts, value}] samples accumulated over time'),
  transform: z.string().optional().describe('JSONata applied to the node input (latest value or history array)'),
  props: z.record(z.string(), z.unknown()).default({}).describe('widget-specific props, see catalog'),
  layout: Layout.optional(),
  style: NodeStyle.optional().describe('overrides the canvas style for this widget'),
});
export type CanvasNode = z.infer<typeof CanvasNode>;
export type CanvasNodeInput = z.input<typeof CanvasNode>;

export type StoredNode = CanvasNode & {
  x: number;
  y: number;
  w: number;
  h: number;
  /** A person moved or resized it: agent updates keep its geometry. */
  pinned: boolean;
  /** Style fields a person changed on the canvas: agent updates keep their values. */
  stylePins?: (keyof NodeStyle)[];
};

export interface Canvas {
  id: string;
  title: string;
  /** Default style of every widget on the canvas. */
  style?: NodeStyle;
  nodes: StoredNode[];
  updatedAt: string;
}

// ---------- operations ----------

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('source.upsert'), source: Source }),
  z.object({ op: z.literal('source.delete'), id: Id }),
  z.object({ op: z.literal('node.upsert'), node: CanvasNode }),
  z.object({ op: z.literal('node.delete'), id: Id }),
]);
export type Op = z.infer<typeof Op>;

export const ApplyRequest = z.object({
  canvas: Id.default('main'),
  title: z.string().optional(),
  style: NodeStyle.optional().describe('default style for every widget on the canvas; replaces the previous default'),
  ops: z.array(Op).min(1).max(200),
  dryRun: z
    .boolean()
    .default(false)
    .describe('run every touched source once and render every touched node without saving'),
});
export type ApplyRequest = z.infer<typeof ApplyRequest>;
export type ApplyRequestInput = z.input<typeof ApplyRequest>;

export interface DryRunResult {
  ok: boolean;
  sources: { id: string; ok: boolean; sample?: unknown; error?: string }[];
  nodes: { id: string; ok: boolean; sample?: unknown; error?: string }[];
}

export interface ApplyResult {
  canvas: string;
  applied: number;
  needsApproval: string[];
  url: string;
}

// ---------- view (what the UI renders) ----------

export interface NodeView extends StoredNode {
  data?: unknown;
  error?: string;
  sourceState?: SourceState;
}

export interface CanvasView {
  canvas: { id: string; title: string; updatedAt: string; style?: NodeStyle };
  nodes: NodeView[];
}

export type ServerMessage = { type: 'changed'; canvas?: string; source?: string };

// ---------- drawing (human-drawn Excalidraw layer, spike) ----------

/**
 * Freehand drawings, shapes and text people add on the canvas. Stored as opaque Excalidraw
 * elements next to the canvas; widget nodes are never part of it.
 */
export const CanvasDrawing = z.object({
  elements: z.array(z.record(z.string(), z.unknown())).max(20_000),
  files: z.record(z.string(), z.unknown()).default({}),
});
export type CanvasDrawing = z.infer<typeof CanvasDrawing>;
