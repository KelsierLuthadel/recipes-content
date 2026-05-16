// Scan every recipe's Overview section for voice issues: ingredients
// or kitchen-tools used as active subjects ("the sofrito gets cumin",
// "eggs crack into wells", "the pan covers"). The shakshuka pre-fix
// is the canonical example.
//
// Heuristic patterns - false positives possible but every match is at
// least worth a human glance.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);

// "Inanimate noun" + active verb that should be passive when the noun
// doesn't actually perform the action. The verb list is conservative:
// only verbs where the cook (not the ingredient) does the action.
const INANIMATE_NOUNS = [
  // ingredients / dish names
  'sofrito', 'mirepoix', 'mixture', 'paste', 'dough', 'batter', 'filling',
  'sauce', 'gravy', 'broth', 'stock', 'soup', 'syrup', 'glaze', 'marinade',
  'rice', 'pasta', 'noodles?', 'bread', 'pastry',
  'meat', 'chicken', 'lamb', 'beef', 'pork', 'fish', 'prawn[s]?',
  'eggs?', 'tofu', 'cheese', 'butter',
  'onion[s]?', 'tomato(?:es)?', 'garlic',
  // tools and vessels
  'pan', 'lid', 'skillet', 'wok', 'pot', 'dish', 'tray', 'tin', 'bowl',
  'oven', 'grill', 'griddle', 'kettle', 'steamer',
];
// Active verbs that flag a problem when the subject is inanimate.
// (E.g. "pan covers" - pans don't cover themselves; a cook covers the pan.)
const ACTIVE_VERBS = [
  'gets?', 'covers?', 'wraps?', 'seals?', 'crisps?', 'softens?',
  'crack[s]?(?:\\s+(?:into|over|onto))?',
  'pour[s]?(?:\\s+(?:into|over|out))?',
  'fold[s]?(?:\\s+(?:into|in|through))?',
  'crumbles?', 'shreds?', 'flakes?',
];

function buildPattern() {
  const nouns = INANIMATE_NOUNS.join('|');
  const verbs = ACTIVE_VERBS.join('|');
  // "the <noun> <verb>" or "<noun> <verb>" at sentence start. \b for
  // whole-word matching; case-insensitive on the noun side.
  return new RegExp(`\\b(?:the|a|an)?\\s*(${nouns})\\s+(${verbs})\\b`, 'gi');
}

const PATTERN = buildPattern();

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

function extractOverviewText(md) {
  const m = md.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
  if (!m) return null;
  return m[1].trim();
}

const files = await walk(ROOT, true);
const hits = [];
for (const f of files) {
  const md = await readFile(f, 'utf8');
  const overview = extractOverviewText(md);
  if (!overview) continue;
  const matches = [...overview.matchAll(PATTERN)];
  if (matches.length === 0) continue;
  hits.push({
    file: path.relative(ROOT, f).replace(/\\/g, '/'),
    overview,
    matches: matches.map(m => m[0]),
  });
}

console.error(`Total recipes with Overview: scanned ${files.length}`);
console.error(`Flagged: ${hits.length}`);
process.stdout.write(JSON.stringify(hits, null, 2));
