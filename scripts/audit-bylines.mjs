// Audit hero bylines (the italic line immediately under the recipe
// image / H1). For each recipe, report whether the byline is missing,
// short enough (<=140 chars), or too long (>140 chars). Used to size
// the rewrite batch before doing the work.
//
// Usage: node scripts/audit-bylines.mjs [--limit N] [--list long|missing|all]
// Default: prints counts only. --list long prints the long ones with their
// length; --list missing prints the slugs with no byline.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
// Recipes live in many top-level dirs (cuisine, baking, sauces, stocks,
// bread-pasta, etc.). Skip the obvious non-recipe ones.
const SKIP_DIRS = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);
const LIMIT_CHARS = 140;

async function walk(dir, isRoot = false) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name === 'resources') continue;
      out.push(...await walk(full));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      // Skip README, LICENSE-style markdown at the root.
      if (isRoot && /^(readme|license|changelog)\.md$/i.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

// Find the italic byline near the top of the file. Pattern: a paragraph
// that is wholly wrapped in single asterisks (`*...*`) and appears
// within the first 15 non-empty lines. Matches the hero.js detection
// rule (entire paragraph wrapped in <em>).
function extractByline(md) {
  const lines = md.split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 15; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    seen++;
    // Skip the H1 and any image paragraph.
    if (/^#\s/.test(trimmed)) continue;
    if (/^!\[/.test(trimmed)) continue;
    // Stop at frontmatter-style lines (Serves: / Prep:) or section
    // headings - the byline always sits above these.
    if (/^\*\*[A-Za-z][^*]*:\*\*/.test(trimmed)) return null;
    if (/^##\s/.test(trimmed)) return null;
    // Italic byline: starts with * and ends with * and has no bare *
    // in the middle (one paragraph wrapped in em).
    if (/^\*[^*].*[^*]\*$/.test(trimmed) || /^\*[^*]+\*$/.test(trimmed)) {
      const inner = trimmed.slice(1, -1).replace(/\s+/g, ' ').trim();
      return inner;
    }
    // First non-skipped, non-italic content line means there's no byline.
    return null;
  }
  return null;
}

function slugOf(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

async function main() {
  const args = process.argv.slice(2);
  const listMode = (args.includes('--list') ? args[args.indexOf('--list') + 1] : null);
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity;

  const files = await walk(ROOT, true);
  const missing = [];
  const long = [];
  const ok = [];
  for (const f of files) {
    const md = await readFile(f, 'utf8');
    const b = extractByline(md);
    const slug = slugOf(f);
    if (b == null) missing.push({ slug });
    else if (b.length > LIMIT_CHARS) long.push({ slug, len: b.length, text: b });
    else ok.push({ slug, len: b.length });
  }

  console.log(`Total recipes:       ${files.length}`);
  console.log(`  byline missing:    ${missing.length}`);
  console.log(`  byline > ${LIMIT_CHARS}:    ${long.length}`);
  console.log(`  byline <= ${LIMIT_CHARS}:    ${ok.length}`);

  if (listMode === 'long' || listMode === 'all') {
    console.log('\n=== Long bylines (>140 chars) ===');
    long.sort((a, b) => b.len - a.len).slice(0, limit).forEach(r =>
      console.log(`[${r.len}] ${r.slug}\n    ${r.text}`),
    );
  }
  if (listMode === 'missing' || listMode === 'all') {
    console.log('\n=== Missing bylines ===');
    missing.slice(0, limit).forEach(r => console.log(`  ${r.slug}`));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
