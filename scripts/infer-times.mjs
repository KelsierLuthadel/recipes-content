#!/usr/bin/env node
// Infers Prep Time and Cook Time for recipes that don't already have them, by scanning the
// markdown for time durations in the method and counting prep verbs in the ingredient list.
//
// Usage:
//   node scripts/infer-times.mjs               # dry-run, prints proposed values
//   node scripts/infer-times.mjs --apply       # writes Prep/Cook Time lines into markdown
//   node scripts/infer-times.mjs --filter <re> # only files whose path matches regex

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md']);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const filterIdx = args.indexOf('--filter');
const FILTER = filterIdx >= 0 ? new RegExp(args[filterIdx + 1], 'i') : null;
const SHOW_LIMIT = args.includes('--all') ? Infinity : 30;

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
  const root = REPO_ROOT.endsWith('/') || REPO_ROOT.endsWith('\\') ? REPO_ROOT.slice(0, -1) : REPO_ROOT;
  return abs.slice(root.length + 1).split('\\').join('/');
}

function hasTimes(md) {
  return /^\s*\*\*Prep Time:\*\*/im.test(md) || /^\s*\*\*Cook Time:\*\*/im.test(md);
}

function extractSection(md, headingRegex) {
  const re = new RegExp(`^##\\s+(?:${headingRegex})\\s*\\n([\\s\\S]*?)(?=^##\\s|\\z)`, 'mi');
  const m = md.match(re);
  return m ? m[1] : '';
}

const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

function parseNumber(raw) {
  let s = raw.trim();
  // ranges: take upper bound
  const range = s.match(/^(\d+(?:\.\d+)?)\s*(?:to|[--])\s*(\d+(?:\.\d+)?)/i);
  if (range) return parseFloat(range[2]);
  // fractions like 1½ or just ½
  let total = 0;
  let consumed = false;
  const intMatch = s.match(/^(\d+(?:\.\d+)?)/);
  if (intMatch) { total += parseFloat(intMatch[1]); s = s.slice(intMatch[0].length).trim(); consumed = true; }
  for (const ch of s) {
    if (FRAC[ch] !== undefined) { total += FRAC[ch]; consumed = true; }
  }
  return consumed ? total : NaN;
}

const PASSIVE = /(?:marinate|\brest\b|stand|set aside|chill|refrigerate|cool|leave\s+(?:to|for)|overnight|defrost|infuse|\bsoak\b|proof\b|prove\b|ferment|\brise\b|knead|autolyse|store\s+in|stored?\b|\bsit\b|\bsits\b|warm\s+place|cold\s+place|spray|maintain|every\b|cover\s+(?:with|and))/i;
const COOK_VERBS = /\b(cook|simmer|bake|baked|fry|fried|saut[eé]|saut[eé]ed|boil|boiled|roast|roasted|grill|grilled|braise|braised|steam|steamed|broil|broiled|sear|seared|poach|poached|reduce|stir-fry|stir-fried|stir fry|deep-fry|deep-fried|stew|smoked|brown|browned|toast|toasted|caramelis[ze]|caramelis[ze]d|render|rendered|melt|melted)\b/i;

function inferCookMinutes(method) {
  if (!method) return 0;
  let total = 0;
  for (const lineRaw of method.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (PASSIVE.test(line)) continue;
    if (/^#{2,}\s/.test(line)) continue;
    if (!COOK_VERBS.test(line)) continue;
    const re = /(\d[\d\s.\--to]*[½¼¾⅓⅔]?)\s*(minutes?|mins?|hours?|hrs?)\b/gi;
    let m;
    while ((m = re.exec(line)) !== null) {
      const n = parseNumber(m[1]);
      if (!isFinite(n) || n <= 0) continue;
      const unit = m[2].toLowerCase();
      const minutes = /hour|hr/.test(unit) ? n * 60 : n;
      total += minutes;
    }
  }
  // sanity cap at 4 hours
  return Math.min(Math.round(total), 240);
}

function inferPrepMinutes(ingredients) {
  if (!ingredients) return 0;
  const lines = ingredients.split(/\r?\n/).filter(l => /^-\s/.test(l));
  const ingCount = lines.length;
  if (ingCount === 0) return 0;
  let prepOps = 0;
  const prepVerbs = /(chopped|diced|minced|sliced|grated|peeled|crushed|deseeded|de-seeded|julienned|pounded|halved|quartered|cubed|finely\s+chopped|roughly\s+chopped|bruised|cut\s+into|de-veined|deveined|shredded|crumbled|broken|trimmed|stoned|cored)/i;
  for (const l of lines) if (prepVerbs.test(l)) prepOps++;
  // require either some prep work or a meaningfully long list to infer prep time
  if (prepOps === 0 && ingCount < 6) return 0;
  let est = 5 + Math.round(ingCount * 0.3) + prepOps * 1.5;
  est = Math.round(est / 5) * 5;
  if (est < 5) est = 5;
  if (est > 60) est = 60;
  return est;
}

function formatMinutes(mins) {
  if (mins <= 0) return null;
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hWord = h === 1 ? 'hour' : 'hours';
  if (m === 0) return `${h} ${hWord}`;
  return `${h} ${hWord} ${m} minutes`;
}

function patchMarkdown(md, prepText, cookText) {
  // Find **Serves:** line; insert after it. If absent, insert after H1.
  const lines = md.split(/\r?\n/);
  const additions = [];
  if (prepText) additions.push(`**Prep Time:** ${prepText}`);
  if (cookText) additions.push(`**Cook Time:** ${cookText}`);
  if (!additions.length) return null;

  const servesIdx = lines.findIndex(l => /^\s*\*\*Serves:\*\*/i.test(l));
  if (servesIdx >= 0) {
    lines.splice(servesIdx + 1, 0, ...additions);
    return lines.join('\n');
  }
  const h1Idx = lines.findIndex(l => /^#\s+/.test(l));
  if (h1Idx >= 0) {
    // find the next blank line after H1 (after potential image / italic intro)
    let insertAt = h1Idx + 1;
    while (insertAt < lines.length && lines[insertAt].trim() !== '') insertAt++;
    lines.splice(insertAt, 0, '', ...additions);
    return lines.join('\n');
  }
  return null;
}

// ---- main ----

let files = walk(REPO_ROOT);
if (FILTER) files = files.filter(f => FILTER.test(relPath(f)));

let touched = 0;
let already = 0;
let printed = 0;
const updates = [];

for (const file of files) {
  const md = readFileSync(file, 'utf8');
  if (hasTimes(md)) { already++; continue; }
  const method = extractSection(md, 'Method|Steps');
  const ingredients = extractSection(md, 'Ingredients');
  const cookMin = inferCookMinutes(method);
  const prepMin = inferPrepMinutes(ingredients);
  const cookText = formatMinutes(cookMin);
  const prepText = formatMinutes(prepMin);

  if (!prepText && !cookText) continue;

  updates.push({ file, prepText, cookText, prepMin, cookMin });

  if (printed < SHOW_LIMIT) {
    console.log(`  ${relPath(file).padEnd(70)}  prep: ${prepText || '-'}   cook: ${cookText || '-'}`);
    printed++;
  }

  if (APPLY) {
    const next = patchMarkdown(md, prepText, cookText);
    if (next) {
      writeFileSync(file, next, 'utf8');
      touched++;
    }
  }
}

console.log('');
console.log(`recipes scanned:        ${files.length}`);
console.log(`already had times:      ${already}`);
console.log(`would update / updated: ${updates.length}`);
if (APPLY) console.log(`files written:          ${touched}`);
if (!APPLY && updates.length > SHOW_LIMIT) console.log(`(printed first ${SHOW_LIMIT}; pass --all to see everything)`);
