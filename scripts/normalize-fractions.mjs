#!/usr/bin/env node
// Normalise fraction notation in recipe markdown files.
//
// Converts:
//   1 1/2          -> 1 ½    (mixed ascii)
//   1/2            -> ½      (lone ascii)
//   1.5            -> 1 ½    (clean decimal with whole part)
//   0.5 / .5       -> ½      (clean decimal alone)
//   1½             -> 1 ½    (glued unicode -> spaced)
//
// Only "clean" decimals convert (.125 .25 .333 .375 .5 .625 .667 .75 .875).
// Irrational decimals like 1.3 stay as-is.
//
// Boundary guards: a fraction must not be flanked by another digit / dot /
// slash, so dates (1/2/2024), version strings (0.8.1) and IP-shaped tokens
// stay intact.
//
// Code fences and inline `code spans` are passed through unchanged.
//
// Usage:
//   node scripts/normalize-fractions.mjs           # dry-run, summary + per-file diff
//   node scripts/normalize-fractions.mjs --apply   # write changes back
//   node scripts/normalize-fractions.mjs --quiet   # dry-run, summary only

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const QUIET = process.argv.includes('--quiet');

const SKIP_BASENAMES = new Set([
  'README.md', 'AUTHORING.md', 'CHANGELOG.md',
  'RECIPE_TEMPLATE.md', 'TODO-course-expansion.md',
  'new.md',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'docs', 'documentation', 'TODO']);

const FRAC_MAP = {
  '1/2': '½', '1/4': '¼', '3/4': '¾',
  '1/3': '⅓', '2/3': '⅔',
  '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞',
};

const DECIMAL_TARGETS = [
  [0.125, '⅛'], [0.25, '¼'], [0.333, '⅓'], [0.375, '⅜'],
  [0.5, '½'], [0.625, '⅝'], [0.667, '⅔'], [0.75, '¾'], [0.875, '⅞'],
];

function decimalToGlyph(d) {
  for (const [v, g] of DECIMAL_TARGETS) {
    if (Math.abs(d - v) < 0.005) return g;
  }
  return null;
}

// Apply normalisation to a chunk of plain (non-code) text.
function normalizeText(text) {
  // Pass 1: mixed ascii fractions (`1 1/2` -> `1 ½`).
  text = text.replace(/(?<![\d./])(\d+)\s+(\d+)\/(\d+)(?![\d./])/g, (m, w, n, d) => {
    const g = FRAC_MAP[`${n}/${d}`];
    return g ? `${w} ${g}` : m;
  });

  // Pass 2: lone ascii fractions (`1/2` -> `½`).
  text = text.replace(/(?<![\d./])(\d+)\/(\d+)(?![\d./])/g, (m, n, d) => {
    return FRAC_MAP[`${n}/${d}`] || m;
  });

  // Pass 3: clean decimals (`1.5` -> `1 ½`, `0.5` / `.5` -> `½`).
  text = text.replace(/(?<![\d.])(\d*)\.(\d+)(?![\d.])/g, (m, w, frac) => {
    const f = parseFloat(`0.${frac}`);
    const glyph = decimalToGlyph(f);
    if (!glyph) return m;
    const whole = parseInt(w || '0', 10);
    return whole === 0 ? glyph : `${whole} ${glyph}`;
  });

  // Pass 4: glued unicode (`1½`) -> spaced (`1 ½`).
  text = text.replace(/(\d)([½¼¾⅓⅔⅛⅜⅝⅞])/g, '$1 $2');

  return text;
}

// Split the file into code-fence and non-fence segments so the normaliser
// only touches prose / list content, never code blocks. Inline backticks
// are left alone too (single-line `code` chunks).
function normalizeMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // Pull out inline `code` runs, normalise the rest, reassemble.
    const parts = line.split(/(`[^`]*`)/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) parts[i] = normalizeText(parts[i]);
    }
    out.push(parts.join(''));
  }
  return out.join('\n');
}

function walkMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkMarkdown(full, acc);
    } else if (entry.endsWith('.md') && !SKIP_BASENAMES.has(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push({ line: i + 1, before: a[i], after: b[i] });
  }
  return out;
}

function main() {
  const files = walkMarkdown(REPO_ROOT);
  let changedFiles = 0;
  let totalLineChanges = 0;
  const sample = [];

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const after = normalizeMarkdown(before);
    if (before === after) continue;

    changedFiles++;
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
    const diff = diffLines(before, after);
    totalLineChanges += diff.length;

    if (APPLY) {
      writeFileSync(file, after, 'utf8');
    }

    if (!QUIET && sample.length < 10) {
      sample.push({ rel, diff: diff.slice(0, 5) });
    }
  }

  if (!QUIET && sample.length) {
    console.log('Sample diffs (first 10 files, first 5 changed lines each):');
    for (const { rel, diff } of sample) {
      console.log(`\n${rel}`);
      for (const d of diff) {
        console.log(`  L${d.line}`);
        console.log(`  - ${d.before}`);
        console.log(`  + ${d.after}`);
      }
    }
    console.log('');
  }

  console.log(`${APPLY ? 'Applied' : 'Would change'}: ${changedFiles} files, ${totalLineChanges} lines.`);
  if (!APPLY) console.log('Run with --apply to write changes.');
}

main();
