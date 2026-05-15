#!/usr/bin/env node
// Normalises explicit Prep / Cook time fields to canonical `**Prep Time:**` / `**Cook Time:**`,
// cleaning the value (drops parentheticals and "+ extra" qualifiers, normalises units).
//
// Usage:
//   node scripts/normalize-times.mjs           # dry-run
//   node scripts/normalize-times.mjs --apply   # write changes back

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md']);

const APPLY = process.argv.includes('--apply');

function walk(dir, files = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (e.endsWith('.md') && !SKIP_FILES.has(e)) files.push(p);
  }
  return files;
}

function relPath(abs) {
  const root = REPO_ROOT.replace(/[\\/]+$/, '');
  return abs.slice(root.length + 1).split('\\').join('/');
}

function cleanValue(s) {
  if (s == null) return null;
  let v = s.trim();
  if (!v) return null;
  if (/^(none|n\/a|-)$/i.test(v)) return null;
  // Extract just the leading time expression. Allows "1 hour 15 minutes",
  // "5-6 minutes", "1.5 hours", "30 mins" etc., and stops at any trailing
  // qualifier such as "soaking", "(per batch)", or ", plus grilling".
  const m = v.match(/^((?:\d+(?:[.,]\d+)?(?:\s*[--]\s*\d+(?:[.,]\d+)?)?\s*(?:hours?|hrs?|minutes?|mins?))(?:\s+(?:and\s+)?\d+(?:[.,]\d+)?(?:\s*[--]\s*\d+(?:[.,]\d+)?)?\s*(?:hours?|hrs?|minutes?|mins?))?)/i);
  if (!m) return null;
  v = m[1].trim();
  // Normalise abbreviated units to full words
  v = v.replace(/\bmins?\b/gi, x => x.toLowerCase() === 'mins' ? 'minutes' : 'minute');
  v = v.replace(/\bhrs?\b/gi, x => x.toLowerCase() === 'hrs' ? 'hours' : 'hour');
  // Singular agreement where the number is exactly 1
  v = v.replace(/(^|\s)1\s+minutes\b/g, '$11 minute');
  v = v.replace(/(^|\s)1\s+hours\b/g, '$11 hour');
  return v;
}

const PREP_RE = /^([ \t]*)\*\*\s*(?:Prep(?:aration)?(?:\s+Time)?|Prep Time)\s*:\s*\*\*[ \t]*([^\r\n]+?)[ \t]*(\r?\n)?$/gim;
const COOK_RE = /^([ \t]*)\*\*\s*(?:Cook(?:ing)?(?:\s+Time)?|Cook Time)\s*:\s*\*\*[ \t]*([^\r\n]+?)[ \t]*(\r?\n)?$/gim;

function normalize(md) {
  let touched = 0;
  let next = md.replace(PREP_RE, (match, indent, value, nl) => {
    const cleaned = cleanValue(value);
    const replacement = cleaned ? `${indent}**Prep Time:** ${cleaned}${nl || ''}` : '';
    if (replacement !== match) touched++;
    return replacement;
  });
  next = next.replace(COOK_RE, (match, indent, value, nl) => {
    const cleaned = cleanValue(value);
    const replacement = cleaned ? `${indent}**Cook Time:** ${cleaned}${nl || ''}` : '';
    if (replacement !== match) touched++;
    return replacement;
  });
  return { md: next, touched };
}

const files = walk(REPO_ROOT);
let updatedFiles = 0, totalReplacements = 0, removedFields = 0;
const samples = [];

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const { md: after, touched } = normalize(before);
  if (after === before) continue;
  updatedFiles++;
  totalReplacements += touched;

  // count removed (label dropped because value was unavailable)
  const beforePrep = (before.match(/^\*\*\s*(?:Prep(?:aration)?(?:\s+Time)?|Prep Time)\s*:\s*\*\*/gim) || []).length;
  const afterPrep = (after.match(/^\*\*Prep Time:\*\*/gm) || []).length;
  const beforeCook = (before.match(/^\*\*\s*(?:Cook(?:ing)?(?:\s+Time)?|Cook Time)\s*:\s*\*\*/gim) || []).length;
  const afterCook = (after.match(/^\*\*Cook Time:\*\*/gm) || []).length;
  removedFields += (beforePrep - afterPrep) + (beforeCook - afterCook);

  if (samples.length < 12) {
    const beforeLines = before.split(/\r?\n/).filter(l => /\*\*\s*(?:Prep|Cook)/i.test(l));
    const afterLines = after.split(/\r?\n/).filter(l => /\*\*\s*(?:Prep|Cook)/i.test(l));
    samples.push({ rel: relPath(file), before: beforeLines, after: afterLines });
  }

  if (APPLY) writeFileSync(file, after, 'utf8');
}

console.log(`files scanned:       ${files.length}`);
console.log(`files updated:       ${updatedFiles}`);
console.log(`replacements:        ${totalReplacements}`);
console.log(`labels dropped (value was None/empty/unavailable): ${removedFields}`);
console.log('');
console.log('--- sample diffs ---');
for (const s of samples) {
  console.log(`\n${s.rel}`);
  s.before.forEach(l => console.log('  - ' + l));
  s.after.forEach(l => console.log('  + ' + l));
}
console.log('');
if (!APPLY) console.log('(dry-run, pass --apply to write)');
