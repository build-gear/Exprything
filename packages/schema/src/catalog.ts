import { z } from 'zod';

// The catalog is what agents read (via catalog_get) to learn how to author nodes.

export interface WidgetDoc {
  description: string;
  data: string;
  defaultSize: { w: number; h: number };
  props: z.ZodType;
  example: unknown;
}

export const widgetCatalog: Record<'markdown' | 'chart' | 'table' | 'stat' | 'log', WidgetDoc> = {
  markdown: {
    description: 'Rich text. Notes, explanations, generated reports.',
    data: 'string (overrides props.text). Supports GitHub-flavored markdown.',
    defaultSize: { w: 360, h: 220 },
    props: z.object({ text: z.string().optional() }),
    example: { id: 'readme', type: 'markdown', props: { text: '## Repo pulse\nRefreshes every 10 minutes.' } },
  },
  chart: {
    description: 'Any chart, as an Apache ECharts option. The node data is injected as dataset.source.',
    data: 'array of row objects (or arrays). Map columns with series[].encode, e.g. { x: "day", y: "count" }.',
    defaultSize: { w: 520, h: 320 },
    props: z.object({
      option: z.record(z.string(), z.unknown()).describe('ECharts option without dataset; dataset.source is filled from data'),
    }),
    example: {
      id: 'commits-chart',
      type: 'chart',
      source: 'repo-commits',
      props: {
        option: {
          xAxis: { type: 'category' },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', encode: { x: 'day', y: 'count' } }],
        },
      },
    },
  },
  table: {
    description: 'Sortable table of rows.',
    data: 'array of objects',
    defaultSize: { w: 520, h: 320 },
    props: z.object({
      columns: z.array(z.string()).optional().describe('column order; defaults to keys of the first row'),
      maxRows: z.number().int().positive().optional(),
    }),
    example: { id: 'open-prs', type: 'table', source: 'prs', props: { columns: ['title', 'author'] } },
  },
  stat: {
    description: 'One KPI number with optional delta and sparkline.',
    data: 'number, or { value: number, delta?: number, series?: number[] }. Use node.use="history" with a transform to build series.',
    defaultSize: { w: 240, h: 150 },
    props: z.object({
      unit: z.string().optional(),
      decimals: z.number().int().min(0).max(6).optional(),
    }),
    example: {
      id: 'todo-count',
      type: 'stat',
      source: 'todos',
      use: 'history',
      transform: '{ "value": $[-1].value, "series": value }',
      props: { unit: 'TODOs' },
    },
  },
  log: {
    description: 'Tail of a stream of lines or events, newest at the bottom.',
    data: 'array of strings or objects (objects are shown as JSON)',
    defaultSize: { w: 520, h: 260 },
    props: z.object({ maxLines: z.number().int().positive().optional() }),
    example: { id: 'build-log', type: 'log', source: 'build', props: { maxLines: 200 } },
  },
};

/** Excalidraw's default color picks (open-color shade 8 for strokes, shade 2 for fills). */
export const stylePalette = {
  stroke: ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'],
  background: ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'],
};

export const authoringGuide = `Exprything renders nodes on a canvas and keeps them fresh WITHOUT calling an AI again.
Author recipes, not results:
- Put the *way to compute* a value in a source (exec command / file / push), with refresh.every, plus a JSONata transform.
- Never hardcode numbers you computed yourself into a static source; the node would never update.
- Always call canvas_apply with dryRun=true first, inspect the samples, then apply for real.
- exec sources need a one-time human approval before they run on schedule; tell the user to approve in the canvas.
- Use stable ids. Re-applying the same id updates in place.
- node.use="history" gives [{ts, value}] samples the daemon accumulated, which is how trends appear over time.
- The canvas is Excalidraw. Style widgets like its shapes with "style" (strokeColor, backgroundColor, fillStyle,
  strokeWidth, strokeStyle, roughness, roundness, opacity, fontFamily): on a node, or for the whole canvas with the
  apply request's "style". roughness above 0 also draws bar and line charts by hand. Prefer the palette colors.
  Keep fills (hachure, cross-hatch) for stat and markdown widgets; they make charts and tables hard to read.
- Style fields a person changed on the canvas stay as they set them; your updates do not override those.
- When the person says "this" or "these", call canvas_selection: it lists the widgets (node ids) and the shapes,
  text and arrows they have selected on the canvas open in their browser.
- Sources of kind "agent" read what connected coding agents did (after \`exp connect <agent> --activity\`): recent
  events, or one row per session with its state (view "sessions"). The "agent-activity" canvas is built on them.`;
