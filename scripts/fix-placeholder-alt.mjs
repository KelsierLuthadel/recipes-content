#!/usr/bin/env node
// Replace placeholder ![Name](path) alt text with each recipe's H1 title.
// Idempotent: re-running is a no-op once every Name has been replaced.
//
// Usage:
//   node scripts/fix-placeholder-alt.mjs           # dry-run
//   node scripts/fix-placeholder-alt.mjs --apply   # write changes

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = '.';
const APPLY = process.argv.includes('--apply');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'docs', 'documentation', 'TODO']);
const SKIP_FILES = new Set([
  'README.md', 'AUTHORING.md', 'CHANGELOG.md',
  'RECIPE_TEMPLATE.md', 'TODO-course-expansion.md', 'new.md',
]);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) acc.push(full);
  }
  return acc;
}

function rel(f) { return relative(ROOT, f).split('\\').join('/'); }

const files = walk(ROOT);
const changed = [];

for (const f of files) {
  const md = readFileSync(f, 'utf8');
  // Find H1 (first `# ` line)
  const h1Match = md.match(/^#\s+(.+?)\s*$/m);
  if (!h1Match) continue;
  const title = h1Match[1].trim();
  // Replace ALL ![Name](...) occurrences in this file. There's usually
  // one, but a few recipes have multiple placeholder images.
  let count = 0;
  const next = md.replace(/!\[Name\]\(([^)]+)\)/g, (m, path) => {
    count++;
    return `![${title}](${path})`;
  });
  if (count === 0 || next === md) continue;
  changed.push({ file: rel(f), title, count });
  if (APPLY) writeFileSync(f, next, 'utf8');
}

console.log(`${APPLY ? 'Updated' : 'Would update'}: ${changed.length} files`);
for (const c of changed) {
  console.log(`  ${c.file}  ->  ![${c.title}](...)${c.count > 1 ? `  (×${c.count})` : ''}`);
}
if (!APPLY && changed.length) console.log('\nRun with --apply to write changes.');
