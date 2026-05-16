// One-off helper: emit a JSON list of every recipe that has NO italic
// byline at the top. Includes title and the first chunk of the recipe
// body so the rewriter can write a punchy replacement without re-opening
// each file.
//
// Usage:
//   node scripts/dump-missing-bylines.mjs                # all
//   node scripts/dump-missing-bylines.mjs --limit 100
//   node scripts/dump-missing-bylines.mjs --compact      # title + context only

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

function hasByline(md) {
  const lines = md.split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 15; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    seen++;
    if (/^#\s/.test(t)) continue;
    if (/^!\[/.test(t)) continue;
    if (/^\*\*[A-Za-z][^*]*:\*\*/.test(t)) return false;
    if (/^##\s/.test(t)) return false;
    if (/^\*[^*].*[^*]\*$/.test(t) || /^\*[^*]+\*$/.test(t)) return true;
    return false;
  }
  return false;
}

function extractTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractOverview(md) {
  // First non-empty 12 content lines after the H1 / image. Same compact
  // format as dump-long-bylines.
  const lines = md.split(/\r?\n/);
  const out = [];
  let skipHeader = true;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (skipHeader) {
      if (/^#\s/.test(t) || /^!\[/.test(t)) continue;
      skipHeader = false;
    }
    out.push(t);
    if (out.length >= 12) break;
  }
  return out.join(' / ');
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const limit = parseInt(arg('--limit', String(Infinity)), 10);
const compact = args.includes('--compact');

const files = await walk(ROOT, true);
const rows = [];
for (const f of files) {
  const md = await readFile(f, 'utf8');
  if (hasByline(md)) continue;
  const title = extractTitle(md);
  if (!title) continue;
  const row = {
    file: path.relative(ROOT, f).replace(/\\/g, '/'),
    title,
  };
  if (!compact) row.overview = extractOverview(md);
  rows.push(row);
}
const slice = isFinite(limit) ? rows.slice(0, limit) : rows;
process.stdout.write(JSON.stringify(slice, null, 2));
process.stdout.write('\n');
console.error(`Total missing byline: ${rows.length}. Emitted: ${slice.length}.`);
