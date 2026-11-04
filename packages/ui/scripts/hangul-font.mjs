// Writes src/hangul-font.css from the Poor Story package: the font as 'Exprything Hangul', which the UI's font stacks
// put first. Each subset keeps only its Hangul, since some also hold Latin and digits, which stay with the fonts
// after it, and the font is scaled up to match them. Run this again after updating the package.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@fontsource/poor-story';
const SIZE_ADJUST = '118%';
const HANGUL = [[0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xd7b0, 0xd7ff]];

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, 'node_modules', PACKAGE, 'index.css'), 'utf8');

/** The Hangul part of a unicode-range. */
function hangulOf(ranges) {
  return ranges.split(',').flatMap((range) => {
    const [from, to = from] = range.trim().slice(2).split('-').map((hex) => parseInt(hex, 16));
    return HANGUL.flatMap(([lo, hi]) => {
      const a = Math.max(from, lo);
      const b = Math.min(to, hi);
      return a > b ? [] : [a === b ? `U+${a.toString(16)}` : `U+${a.toString(16)}-${b.toString(16)}`];
    });
  }).join(',');
}

const faces = [...css.matchAll(/url\(\.\/(files\/[^)]+\.woff2\))[^}]*?unicode-range: ([^;]+);/g)].flatMap(([, file, ranges]) => {
  const range = hangulOf(ranges);
  return range
    ? [`@font-face { font-family: 'Exprything Hangul'; font-display: swap; size-adjust: ${SIZE_ADJUST}; src: url(${PACKAGE}/${file.slice(0, -1)}) format('woff2'); unicode-range: ${range}; }`]
    : [];
});

writeFileSync(
  join(root, 'src/hangul-font.css'),
  ['/* Written by scripts/hangul-font.mjs. Poor Story, (c) YoonDesign Inc., SIL Open Font License 1.1. */', ...faces, ''].join('\n'),
);
console.log(`${faces.length} faces`);
