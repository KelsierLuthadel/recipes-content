// One-off: emit a JSON dump of every recipe whose hero byline is over
// THRESHOLD chars. Includes title, current byline, and the first 30
// content lines (skipping the H1/image) so a reviewer can write a
// punchy replacement without re-opening each file. Sorted longest
// first so the worst offenders surface first.
//
// Output: prints JSON array to stdout. Pipe to a file with `> dump.json`
// or use --limit N to cap.
//
// Usage:
//   node scripts/dump-long-bylines.mjs                 # all > 320
//   node scripts/dump-long-bylines.mjs --threshold 320 # explicit
//   node scripts/dump-long-bylines.mjs --limit 30      # cap count
//   node scripts/dump-long-bylines.mjs --offset 30 --limit 30
//
// Safe to delete once the byline rewrite project lands.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);

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

function parse(md) {
  const lines = md.split(/\r?\n/);
  let title = null;
  let bylineRaw = null;       // the raw markdown line including asterisks
  let bylineLineIdx = -1;
  let bylineText = null;
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 15; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    seen++;
    const h1 = t.match(/^#\s+(.+)$/);
    if (h1) { if (!title) title = h1[1].trim(); continue; }
    if (/^!\[/.test(t)) continue;
    if (/^\*\*[A-Za-z][^*]*:\*\*/.test(t)) break;
    if (/^##\s/.test(t)) break;
    if (/^\*[^*].*[^*]\*$/.test(t) || /^\*[^*]+\*$/.test(t)) {
      bylineRaw = raw;
      bylineLineIdx = i;
      bylineText = t.slice(1, -1).replace(/\s+/g, ' ').trim();
      break;
    }
    break;
  }
  return { title, bylineRaw, bylineLineIdx, bylineText };
}

function firstContextLines(md, fromIdx, count) {
  // Pull the first `count` non-empty lines starting from the byline
  // line (inclusive). Gives the reviewer the overview section + a
  // few stage headings to anchor a rewrite.
  const lines = md.split(/\r?\n/);
  const out = [];
  for (let i = fromIdx; i < lines.length && out.length < count; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    out.push(t);
  }
  return out;
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const threshold = parseInt(arg('--threshold', '320'), 10);
const limit = parseInt(arg('--limit', String(Infinity)), 10);
const offset = parseInt(arg('--offset', '0'), 10);
// --compact omits the overview field so a 300-row batch JSON stays under
// the read-tool's slurp limit. Title + current byline are enough context
// for the rewriter to write a punchy replacement.
const compact = args.includes('--compact');

const files = await walk(ROOT, true);
const rows = [];
for (const f of files) {
  const md = await readFile(f, 'utf8');
  const p = parse(md);
  if (!p.bylineText) continue;
  if (p.bylineText.length <= threshold) continue;
  const row = {
    file: path.relative(ROOT, f).replace(/\\/g, '/'),
    title: p.title,
    len: p.bylineText.length,
    byline: p.bylineText,
  };
  if (!compact) row.overview = firstContextLines(md, p.bylineLineIdx + 1, 12).join(' / ');
  rows.push(row);
}
rows.sort((a, b) => b.len - a.len);
const slice = rows.slice(offset, isFinite(limit) ? offset + limit : undefined);
process.stdout.write(JSON.stringify(slice, null, 2));
process.stdout.write('\n');
console.error(`Total >${threshold}: ${rows.length}. Emitted: ${slice.length} (offset ${offset}).`);
