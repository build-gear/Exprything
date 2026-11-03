import DOMPurify from 'dompurify';
import * as echarts from 'echarts';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fontStack, inkOf, loadFonts, seriesColors, type Look } from '../style.ts';
import { SketchChart, SketchSparkline, sketchSeries } from './sketch.tsx';

type Props = { data: unknown; props: Record<string, unknown>; look?: Look; seedKey?: string };
type Row = Record<string, unknown>;

export function Markdown({ data, props }: Props) {
  const text = typeof data === 'string' ? data : String(props.text ?? '');
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  return <div className="w-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function useDark(): boolean {
  const [dark, setDark] = useState(darkQuery.matches);
  useEffect(() => {
    const on = () => setDark(darkQuery.matches);
    darkQuery.addEventListener('change', on);
    return () => darkQuery.removeEventListener('change', on);
  }, []);
  return dark;
}

/** Hand-drawn when the style is rough and the option is simple enough; ECharts otherwise. */
export function Chart({ data, props, look, seedKey = '' }: Props) {
  const rows = useMemo(() => asRows(data) as Row[], [data]);
  const sketch = useMemo(
    () => (look && look.roughness > 0 ? sketchSeries((props.option ?? {}) as Record<string, unknown>) : null),
    [look, props.option],
  );
  if (sketch && look) return <SketchChart rows={rows} series={sketch} look={look} seedKey={seedKey} />;
  return <EChart data={data} option={props.option} look={look} />;
}

/**
 * Always drawn with the light theme: in dark mode Excalidraw's canvas filter, which reaches every
 * <canvas> inside it (ours included), darkens the chart exactly like the shapes around it.
 */
function EChart({ data, option, look }: { data: unknown; option: unknown; look?: Look }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const dark = useDark();
  const styled = !!look && (!!look.fontFamily || !!inkOf(look));

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const rows = data != null ? asRows(data) : undefined;
    const fontFamily = styled ? fontStack(look) : undefined;
    const apply = () => {
      if (cancelled || !chart.current) return;
      chart.current.setOption(
        {
          backgroundColor: 'transparent',
          grid: { left: 40, right: 16, top: 24, bottom: 28, containLabel: true },
          // The tooltip is HTML, so the canvas filter does not reach it; theme it directly.
          tooltip: {
            trigger: 'axis',
            ...(dark && { backgroundColor: '#232329', borderColor: '#3d3d44' }),
            textStyle: { ...(dark && { color: '#e3e3e8' }), ...(fontFamily && { fontFamily }) },
          },
          ...(styled && { color: seriesColors(look).map(([stroke]) => stroke), textStyle: { fontFamily } }),
          ...((option ?? {}) as Record<string, unknown>),
          ...(rows && { dataset: { source: rows } }),
        },
        true,
      );
    };
    // ECharts paints text on a canvas, which does not repaint when a web font arrives.
    if (styled && look?.fontFamily) void loadFonts(look, sampleText(rows)).then(apply);
    else apply();
    return () => { cancelled = true; };
  }, [data, option, dark, styled, look]);

  return <div ref={el} className="w-chart" />;
}

export function Table({ data, props }: Props) {
  const rows = asRows(data) as Row[];
  const columns = (props.columns as string[] | undefined) ?? Object.keys(rows[0] ?? {});
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    const r = [...rows];
    if (sort) r.sort((a, b) => (a[sort.col]! > b[sort.col]! ? sort.dir : a[sort.col]! < b[sort.col]! ? -sort.dir : 0));
    return r.slice(0, Number(props.maxRows ?? 1_000));
  }, [rows, sort, props.maxRows]);

  return (
    <div className="w-table">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} onClick={() => setSort((s) => ({ col: c, dir: s?.col === c && s.dir === 1 ? -1 : 1 }))}>
                {c}{sort?.col === c ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c}>{format(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Stat({ data, props, look, seedKey = '' }: Props) {
  const d = typeof data === 'number' ? { value: data } : ((data ?? {}) as { value?: number; delta?: number; series?: number[] });
  const decimals = props.decimals as number | undefined;
  const value = typeof d.value === 'number' ? d.value.toLocaleString(undefined, { maximumFractionDigits: decimals ?? 2 }) : '—';
  const ink = look && inkOf(look);
  const series = Array.isArray(d.series) ? d.series.filter((v) => typeof v === 'number') : [];
  return (
    <div className="w-stat">
      <div className="w-stat-value">
        <span className={ink ? 'wn-ink' : undefined}>{value}</span>
        {props.unit ? <span className="w-stat-unit">{String(props.unit)}</span> : null}
      </div>
      {typeof d.delta === 'number' && (
        <div className={d.delta >= 0 ? 'w-stat-delta up' : 'w-stat-delta down'}>
          {d.delta >= 0 ? '▲' : '▼'} {Math.abs(d.delta).toLocaleString()}
        </div>
      )}
      {series.length > 1 && (look && look.roughness > 0
        ? <SketchSparkline values={series} look={look} seedKey={seedKey} color={ink ?? seriesColors()[0][0]} />
        : <Sparkline values={series} ink={!!ink} />)}
    </div>
  );
}

function Sparkline({ values, ink }: { values: number[]; ink: boolean }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / (max - min || 1)) * 28 - 1}`).join(' ');
  return (
    <svg className={ink ? 'w-spark wn-ink' : 'w-spark'} viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline points={pts} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Log({ data, props }: Props) {
  const lines = (Array.isArray(data) ? data : data == null ? [] : [data]).slice(-Number(props.maxLines ?? 500));
  const el = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (el.current) el.current.scrollTop = el.current.scrollHeight;
  }, [lines.length]);
  return <pre ref={el} className="w-log">{lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}</pre>;
}

/** JSONata collapses one-item results to the item itself; treat a lone object as a single row. */
function asRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  return data != null && typeof data === 'object' ? [data] : [];
}

/** Text a chart will show, so the right font subsets (e.g. Hangul) are loaded before it paints. */
function sampleText(rows: unknown[] | undefined): string {
  return (rows ?? []).slice(0, 50).map((r) => (r && typeof r === 'object' ? Object.values(r).join(' ') : String(r))).join(' ');
}

function format(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toLocaleString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const widgets: Record<string, (p: Props) => React.ReactNode> = {
  markdown: Markdown,
  chart: Chart,
  table: Table,
  stat: Stat,
  log: Log,
};
