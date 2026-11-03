import rough from 'roughjs';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { roughOptions, seriesColors, stableSeed, type Look } from '../style.ts';

/*
 * Hand-drawn charts with rough.js, the engine Excalidraw draws its shapes with, using the same
 * option mapping, palette and per-shape seeds. Colors are the light palette; in dark mode the SVG
 * takes Excalidraw's canvas filter (see styles.css), so it matches the shapes around it.
 */

type Row = Record<string, unknown>;

export interface SketchSeries {
  type: 'bar' | 'line';
  x: string;
  y: string;
  name?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const AXIS = '#1e1e1e'; // Excalidraw's default stroke
const LABEL = '#495057'; // open-color gray 7
const GRID = '#dee2e6'; // open-color gray 3

/**
 * The part of an ECharts option drawn by hand: a category x axis with bar and line series that map
 * dataset columns through `encode`. Anything else stays with ECharts.
 */
export function sketchSeries(option: Record<string, unknown>): SketchSeries[] | null {
  const raw = option.series;
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
  if (list.length === 0) return null;
  const xAxis = (Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis) as { type?: string } | undefined;
  if (xAxis?.type && xAxis.type !== 'category') return null;
  const out: SketchSeries[] = [];
  for (const s of list) {
    const enc = s.encode as { x?: unknown; y?: unknown } | undefined;
    if ((s.type !== 'bar' && s.type !== 'line') || typeof enc?.x !== 'string' || typeof enc?.y !== 'string') return null;
    out.push({ type: s.type, x: enc.x, y: enc.y, name: typeof s.name === 'string' ? s.name : undefined });
  }
  return new Set(out.map((s) => s.x)).size === 1 ? out : null;
}

export function useSize(ref: RefObject<Element | null>): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function SketchChart({ rows, series, look, seedKey }: { rows: Row[]; series: SketchSeries[]; look: Look; seedKey: string }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const size = useSize(host);

  useEffect(() => {
    if (svg.current && size && size.w >= 60 && size.h >= 60) drawChart(svg.current, rows, series, look, seedKey, size.w, size.h);
  }, [rows, series, look, seedKey, size]);

  return (
    <div ref={host} className="w-chart">
      <svg ref={svg} className="sketch-chart" width="100%" height="100%" />
    </div>
  );
}

function drawChart(svg: SVGSVGElement, rows: Row[], series: SketchSeries[], look: Look, seedKey: string, width: number, height: number) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const rc = rough.svg(svg);
  const colors = seriesColors(look);

  // One row per category; later rows win, as they would in a dataset lookup.
  const xKey = series[0].x;
  const byCategory = new Map<string, Row>();
  for (const r of rows) byCategory.set(String(r[xKey] ?? ''), r);
  const categories = [...byCategory.keys()];
  const value = (c: string, s: SketchSeries) => {
    const v = Number(byCategory.get(c)?.[s.y]);
    return Number.isFinite(v) ? v : 0;
  };

  const values = series.flatMap((s) => categories.map((c) => value(c, s)));
  const legend = series.length > 1;
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), Math.max(2, Math.floor((height - 50) / 40)));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const m = { l: Math.max(...ticks.map((t) => fmt(t).length)) * 7 + 14, r: 12, t: legend ? 26 : 12, b: 26 };
  const pw = width - m.l - m.r;
  const ph = height - m.t - m.b;
  if (pw <= 20 || ph <= 20 || categories.length === 0) return;
  const X = (i: number) => m.l + (pw * (i + 0.5)) / categories.length;
  const Y = (v: number) => m.t + ph - ((v - lo) / (hi - lo)) * ph;
  const base = Y(Math.max(lo, Math.min(0, hi)));

  for (const t of ticks) {
    if (Y(t) !== base) svg.appendChild(el('line', { x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t), stroke: GRID, 'stroke-dasharray': '3 5' }));
    svg.appendChild(label(fmt(t), m.l - 8, Y(t), 'end'));
  }
  const every = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(pw / 64))));
  categories.forEach((c, i) => {
    if (i % every === 0) svg.appendChild(label(c, X(i), height - 8, 'middle'));
  });

  const axisLook = { ...look, strokeWidth: 1.5, strokeStyle: 'solid' as const };
  svg.appendChild(rc.line(m.l, base, width - m.r, base, roughOptions(axisLook, { seed: stableSeed(seedKey, 'x-axis'), stroke: AXIS, width: pw, height: 0, linear: true })));
  svg.appendChild(rc.line(m.l, m.t, m.l, m.t + ph, roughOptions(axisLook, { seed: stableSeed(seedKey, 'y-axis'), stroke: AXIS, width: 0, height: ph, linear: true })));

  const bars = series.filter((s) => s.type === 'bar');
  const group = (pw / categories.length) * 0.72;
  const bw = group / Math.max(1, bars.length);
  series.forEach((s, si) => {
    const [stroke, fill] = colors[si % colors.length];
    const name = s.name ?? s.y;
    if (s.type === 'bar') {
      const bi = bars.indexOf(s);
      categories.forEach((c, ci) => {
        const v = value(c, s);
        const top = Math.min(Y(v), base);
        const h = Math.abs(Y(v) - base);
        if (h < 1) return;
        const x = X(ci) - group / 2 + bi * bw + bw * 0.08;
        const w = bw * 0.84;
        const shape = rc.rectangle(x, top, w, h, roughOptions(look, {
          seed: stableSeed(seedKey, si, ci), stroke, fill, fillStyle: look.fillStyle ?? 'hachure', width: w, height: h,
        }));
        shape.appendChild(title(`${name} · ${c}: ${fmt(v)}`));
        svg.appendChild(shape);
      });
    } else {
      const points = categories.map((c, ci) => [X(ci), Y(value(c, s))] as [number, number]);
      if (points.length > 1) {
        svg.appendChild(rc.linearPath(points, roughOptions(look, { seed: stableSeed(seedKey, si, 'line'), stroke, width: pw, height: ph, linear: true })));
      }
      points.forEach(([x, y], ci) => {
        const dot = rc.circle(x, y, 7, roughOptions(look, {
          seed: stableSeed(seedKey, si, ci), stroke, fill: stroke, fillStyle: 'solid', width: 7, height: 7,
        }));
        dot.appendChild(title(`${name} · ${categories[ci]}: ${fmt(value(categories[ci], s))}`));
        svg.appendChild(dot);
      });
    }
    if (legend) {
      const text = label(name, width - m.r - (series.length - 1 - si) * 90, 12, 'end');
      text.setAttribute('fill', stroke);
      svg.appendChild(text);
    }
  });
}

/** Hand-drawn sparkline for the stat widget. */
export function SketchSparkline({ values, look, seedKey, color }: { values: number[]; look: Look; seedKey: string; color: string }) {
  const host = useRef<SVGSVGElement>(null);
  const size = useSize(host);
  useEffect(() => {
    const svg = host.current;
    if (!svg || !size || size.w < 20 || size.h < 8) return;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const points = values.map((v, i) => [
      2 + (i / (values.length - 1)) * (size.w - 4),
      size.h - 2 - ((v - min) / (max - min || 1)) * (size.h - 4),
    ] as [number, number]);
    const line = { ...look, strokeWidth: Math.min(look.strokeWidth, 2) };
    svg.appendChild(rough.svg(svg).linearPath(points, roughOptions(line, {
      seed: stableSeed(seedKey, 'spark'), stroke: color, width: size.w, height: size.h, linear: true,
    })));
  }, [values, look, seedKey, color, size]);
  return <svg ref={host} className="w-spark sketch-chart" />;
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / count;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
  const ticks: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= Math.ceil(hi / step) * step + step / 2; t += step) {
    ticks.push(Number(t.toPrecision(12)));
  }
  return ticks;
}

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function label(text: string, x: number, y: number, anchor: 'start' | 'middle' | 'end'): SVGElement {
  const node = el('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': 'middle', fill: LABEL, 'font-size': 11 });
  node.textContent = text;
  return node;
}

function title(text: string): SVGElement {
  const node = document.createElementNS(SVG_NS, 'title');
  node.textContent = text;
  return node;
}
