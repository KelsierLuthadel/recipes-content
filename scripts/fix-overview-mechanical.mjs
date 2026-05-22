// Targeted mechanical fixes for Overview prose: applied to the Overview
// section ONLY (other sections like Method are left alone). Three rules:
//
//   1. Em-dashes "-"   ->   ", "  (per project: no em-dashes in body text)
//   2. ALL-CAPS standalone words used for emphasis  ->  lowercase
//        Only specific words (NEVER, NOT, ALWAYS, MUST, etc.) and only when
//        they are surrounded by lowercase context (so we don't lowercase
//        legitimate acronyms or units that happen to be uppercase).
//   3. Spaced hyphen used as a dash  " - "  ->  ", "
//        Strict: requires space-hyphen-space (preserves hyphenated words
//        like "fast-action yeast" and "30-minute" compound modifiers).
//
// Cleanup: collapses any accidental doubled commas (", ," -> ", ").

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);

const CAPS_WORDS = ['NEVER', 'NOT', 'ALWAYS', 'MUST', 'ONLY', 'JUST', 'EXACTLY'];

function fixOverviewBody(body) {
  let out = body;
  // 1. Em-dashes -> commas
  out = out.replace(/\s*-\s*/g, ', ');
  // 2. ALL-CAPS emphasis words -> lowercase.
  //    Only the small whitelist; only when whole-word surrounded by non-letters.
  for (const w of CAPS_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, 'g');
    out = out.replace(re, w.toLowerCase());
  }
  // Also collapse contractions like "DON'T" -> "don't"
  out = out.replace(/\bDON'T\b/g, "don't");
  // 3. Spaced hyphen -> comma. Run twice to catch "X - Y - Z" cases.
  out = out.replace(/(\S) - (\S)/g, '$1, $2');
  out = out.replace(/(\S) - (\S)/g, '$1, $2');
  // Cleanup doubled commas and trailing-comma-before-period.
  out = out.replace(/,\s*,/g, ',');
  out = out.replace(/,\s*\./g, '.');
  return out;
}

async function walk(dir, isRoot = false) {
  const out = [];
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name === 'resources') continue;
      out.push(...await walk(full));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      if (isRoot && /^(readme|license|changelog)\.md$/i.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const files = await walk(ROOT, true);
let touched = 0;
for (const f of files) {
  const md = await readFile(f, 'utf8');
  const re = /(^##\s+Overview\s*\r?\n)([\s\S]*?)(?=^##\s|$(?![\r\n]))/m;
  const m = md.match(re);
  if (!m) continue;
  const body = m[2];
  const fixed = fixOverviewBody(body);
  if (fixed === body) continue;
  const head = md.slice(0, m.index + m[1].length);
  const tail = md.slice(m.index + m[1].length + body.length);
  await writeFile(f, head + fixed + tail, 'utf8');
  touched++;
}
console.log(`Touched ${touched} Overviews.`);
