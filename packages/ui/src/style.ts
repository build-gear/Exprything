import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { NodeStyle } from '@exprything/schema';
import type { Options as RoughOptions } from 'roughjs/bin/core';

/*
 * Widget style in Excalidraw's vocabulary. Frame fields become properties of the widget's
 * Excalidraw element, so Excalidraw draws the frame; fontFamily and strokeColor (the "ink") also
 * restyle the widget's HTML. Unset fields keep Exprything's clean look.
 */

export type Look = Omit<Required<NodeStyle>, 'fontFamily' | 'fillStyle'> & Pick<NodeStyle, 'fontFamily' | 'fillStyle'>;

const DEFAULT_LOOK: Look = {
  strokeColor: 'transparent',
  backgroundColor: 'transparent',
  strokeWidth: 2, // Excalidraw's default
  strokeStyle: 'solid',
  roughness: 0, // clean unless asked for (Excalidraw itself defaults to 1)
  roundness: 'round',
  opacity: 100,
};

export function resolveLook(canvasStyle?: NodeStyle, nodeStyle?: NodeStyle): Look {
  return { ...DEFAULT_LOOK, ...canvasStyle, ...nodeStyle };
}

const isTransparent = (color: string) => color === 'transparent';

/** The color titles, numbers and the first chart series are drawn in, if the style sets one. */
export const inkOf = (look: Look) => (isTransparent(look.strokeColor) ? undefined : look.strokeColor);


// Excalidraw registers these font faces on the page; CJK text falls back to Xiaolai as on its canvas.
const FONTS = {
  hand: { family: 'Excalifont', stack: 'Excalifont, Xiaolai, sans-serif' },
  normal: { family: 'Nunito', stack: 'Nunito, Xiaolai, sans-serif' },
  code: { family: 'Comic Shanns', stack: '"Comic Shanns", Xiaolai, monospace' },
} as const;

export const fontStack = (look?: Look) => (look?.fontFamily ? FONTS[look.fontFamily].stack : undefined);

/**
 * Canvas-drawn text (ECharts) does not repaint when a web font arrives, so load the faces first.
 * `sample` decides which unicode-range subsets (e.g. Hangul) are fetched.
 */
export async function loadFonts(look: Look | undefined, sample: string): Promise<void> {
  if (!look?.fontFamily) return;
  const text = sample || 'Aa1';
  await Promise.all(
    [FONTS[look.fontFamily].family, 'Xiaolai'].map((f) => document.fonts.load(`16px "${f}"`, text).catch(() => [])),
  );
}

/** Excalidraw's color picker hues: stroke (open-color shade 8) and the matching fill (shade 2). */
const HUES: [stroke: string, fill: string][] = [
  ['#1971c2', '#a5d8ff'],
  ['#e03131', '#ffc9c9'],
  ['#2f9e44', '#b2f2bb'],
  ['#f08c00', '#ffec99'],
  ['#6741d9', '#d0bfff'],
  ['#0c8599', '#99e9f2'],
  ['#e8590c', '#ffd8a8'],
  ['#c2255c', '#fcc2d7'],
];
const BLACK: [string, string] = ['#1e1e1e', '#e9ecef'];

/** Series colors for charts: the ink first (with its palette fill when it has one), then the palette. */
export function seriesColors(look?: Look): [stroke: string, fill: string][] {
  const ink = look && inkOf(look);
  if (!ink) return HUES;
  const known = [...HUES, BLACK].find(([s]) => s.toLowerCase() === ink.toLowerCase());
  return [known ?? [ink, ink], ...HUES.filter(([s]) => s.toLowerCase() !== ink.toLowerCase())];
}

/** Deterministic seed so rough.js draws the same wobble on every render, like Excalidraw's element seed. */
export function stableSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('\u0000')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2 ** 31;
}

/** rough.js options for a shape, mirroring Excalidraw's generateRoughOptions. */
export function roughOptions(
  look: Look,
  shape: { seed: number; stroke: string; fill?: string; fillStyle?: string; width: number; height: number; linear?: boolean },
): RoughOptions {
  const sw = look.strokeWidth;
  const solid = look.strokeStyle === 'solid';
  return {
    seed: shape.seed,
    strokeLineDash: look.strokeStyle === 'dashed' ? [8, 8 + sw] : look.strokeStyle === 'dotted' ? [1.5, 6 + sw] : undefined,
    disableMultiStroke: !solid,
    strokeWidth: solid ? sw : sw + 0.5,
    fillWeight: sw / 2,
    hachureGap: sw * 4,
    roughness: adjustRoughness(look, shape.width, shape.height, shape.linear ?? false),
    stroke: shape.stroke,
    fill: shape.fill,
    fillStyle: shape.fillStyle,
    preserveVertices: shape.linear || look.roughness < 2,
  };
}

/** Excalidraw tones roughness down on small shapes so they stay legible. */
function adjustRoughness(look: Look, width: number, height: number, linear: boolean): number {
  const max = Math.max(width, height);
  const min = Math.min(width, height);
  if ((min >= 20 && max >= 50) || (min >= 15 && look.roundness === 'round') || (linear && max >= 50)) {
    return look.roughness;
  }
  return Math.min(look.roughness / (max < 10 ? 3 : 2), 2.5);
}

// ---------- the widget's frame as Excalidraw element properties ----------

const ADAPTIVE_RADIUS = 3; // Excalidraw's ROUNDNESS.ADAPTIVE_RADIUS

export type Frame = Pick<
  ExcalidrawElement,
  'strokeColor' | 'backgroundColor' | 'fillStyle' | 'strokeWidth' | 'strokeStyle' | 'roughness' | 'roundness' | 'opacity'
>;

export function frameOf(look: Look): Frame {
  return {
    strokeColor: look.strokeColor,
    backgroundColor: look.backgroundColor,
    fillStyle: look.fillStyle ?? 'solid',
    strokeWidth: look.strokeWidth,
    strokeStyle: look.strokeStyle,
    roughness: look.roughness,
    roundness: look.roundness === 'round' ? { type: ADAPTIVE_RADIUS } : null,
    opacity: look.opacity,
  };
}

export function frameOfElement(el: ExcalidrawElement): Frame {
  const { strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, roundness, opacity } = el;
  return { strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, roundness, opacity };
}

/** The style fields that differ between two frames, in the NodeStyle vocabulary. */
export function frameDiff(from: Frame, to: Frame): Partial<NodeStyle> {
  const diff: Partial<NodeStyle> = {};
  if (from.strokeColor !== to.strokeColor) diff.strokeColor = to.strokeColor;
  if (from.backgroundColor !== to.backgroundColor) diff.backgroundColor = to.backgroundColor;
  if (from.fillStyle !== to.fillStyle) diff.fillStyle = to.fillStyle;
  if (from.strokeWidth !== to.strokeWidth) diff.strokeWidth = to.strokeWidth;
  if (from.strokeStyle !== to.strokeStyle) diff.strokeStyle = to.strokeStyle;
  if (from.roughness !== to.roughness) diff.roughness = to.roughness;
  if (!!from.roundness !== !!to.roundness) diff.roundness = to.roundness ? 'round' : 'sharp';
  if (from.opacity !== to.opacity) diff.opacity = to.opacity;
  return diff;
}

export const sameFrame = (a: Frame, b: Frame) => Object.keys(frameDiff(a, b)).length === 0;
