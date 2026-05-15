#!/usr/bin/env node
// Lint every recipe markdown file for the structural fields the manifest
// build and the UI depend on. Errors are things that break extraction
// (no title, broken image link); warnings are things that degrade the
// recipe's UX (no overview, no times, no serves count).
//
// Usage:
//   node scripts/recipe-doctor.mjs                       # all issues
//   node scripts/recipe-doctor.mjs --errors-only         # just the broken ones
//   node scripts/recipe-doctor.mjs --path cuisine/thai   # scope to a sub-tree
//   node scripts/recipe-doctor.mjs --quiet               # only summary
//
// Exit code 0 if there are no errors (warnings allowed); non-zero if any
// recipe has at least one error. Useful as a pre-commit / CI gate.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, posix, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md']);

function toPosix(p) { return p.split(sep).join(posix.sep); }
function relPath(p) { return toPosix(relative(REPO_ROOT, p)); }

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, files);
    } else if (entry.endsWith('.md') && !SKIP_FILES.has(entry)) {
      files.push(full);
    }
  }
  return files;
}

// Same regexes as scripts/build-manifest.mjs, intentionally; the doctor's
// job is to flag anything the build extractors would silently drop.
// Method / Ingredients accept a trailing suffix on the heading
// (e.g. "## Method - Roasting", "## Ingredients (For Dry Spice Mix)")
// so the linter doesn't fight legitimate multi-variant recipes.
const TITLE_RE     = /^#\s+(.+?)\s*$/m;
const IMAGE_RE     = /!\[[^\]]*\]\(([^)]+)\)/;
const SERVES_RE    = /^\*\*(?:Serves|Makes|Yield):\*\*\s*(.+?)\s*$/mi;
const PREP_RE      = /^\*\*Prep Time:\*\*\s*(.+?)\s*$/mi;
const COOK_RE      = /^\*\*Cook Time:\*\*\s*(.+?)\s*$/mi;
const OVERVIEW_RE  = /^##\s+Overview\b/mi;
const INGRED_RE    = /^##\s+Ingredients\b/mi;
const METHOD_RE    = /^##\s+Method\b/mi;
// Bullet line under ## Ingredients - used to flag empty ingredient blocks.
const BULLET_RE    = /^[-*]\s+\S/m;

function check(file) {
  const issues = [];
  const md = readFileSync(file, 'utf8');
  const recipeDir = dirname(file);

  // --- ERRORS ------------------------------------------------------------
  if (!TITLE_RE.test(md)) issues.push({ level: 'err', msg: 'no title (no `# Heading`)' });

  const imgMatch = md.match(IMAGE_RE);
  if (!imgMatch) {
    issues.push({ level: 'err', msg: 'no image link in body' });
  } else {
    const imagePath = imgMatch[1].trim();
    if (!/^https?:/i.test(imagePath)) {
      const onDisk = join(recipeDir, ...imagePath.split('/'));
      if (!existsSync(onDisk)) issues.push({ level: 'err', msg: `image file missing on disk: ${imagePath}` });
    }
  }

  // --- WARNINGS ----------------------------------------------------------
  // No Method is a quality concern, not a build-blocker (the build script
  // never extracts Method - it's just rendered as markdown).
  if (!METHOD_RE.test(md)) issues.push({ level: 'warn', msg: 'no `## Method` section' });
  if (!OVERVIEW_RE.test(md)) issues.push({ level: 'warn', msg: 'no `## Overview` section' });

  if (!INGRED_RE.test(md)) {
    issues.push({ level: 'warn', msg: 'no `## Ingredients` section (search index will skip this recipe\'s ingredients)' });
  } else {
    // Ingredients heading exists; do at least some bullet lines follow it?
    const ingredBlock = md.match(/^##\s+Ingredients\s*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
    if (ingredBlock && !BULLET_RE.test(ingredBlock[1])) {
      issues.push({ level: 'warn', msg: '`## Ingredients` section has no bullet lines' });
    }
  }

  if (!SERVES_RE.test(md)) issues.push({ level: 'warn', msg: 'no Serves / Makes / Yield line' });
  if (!PREP_RE.test(md))   issues.push({ level: 'warn', msg: 'no Prep Time line' });
  if (!COOK_RE.test(md))   issues.push({ level: 'warn', msg: 'no Cook Time line' });

  return issues;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let errorsOnly = false;
  let pathFilter = null;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--errors-only') errorsOnly = true;
    else if (args[i] === '--path') pathFilter = args[++i];
    else if (args[i] === '--quiet') quiet = true;
  }
  return { errorsOnly, pathFilter, quiet };
}

function main() {
  const { errorsOnly, pathFilter, quiet } = parseArgs(process.argv);

  let scanned = 0;
  let cleanCount = 0;
  let withErrors = 0;
  let withWarnings = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  const allIssues = [];
  for (const file of walk(REPO_ROOT)) {
    const rel = relPath(file);
    if (pathFilter && !rel.includes(pathFilter)) continue;
    scanned++;
    const issues = check(file);
    if (!issues.length) { cleanCount++; continue; }
    const errs = issues.filter(i => i.level === 'err');
    const warns = issues.filter(i => i.level === 'warn');
    if (errs.length) withErrors++;
    if (warns.length) withWarnings++;
    totalErrors += errs.length;
    totalWarnings += warns.length;
    if (errorsOnly && !errs.length) continue;
    allIssues.push({ rel, issues: errorsOnly ? errs : issues });
  }

  if (!quiet) {
    for (const r of allIssues) {
      console.log(r.rel);
      for (const i of r.issues) {
        const tag = i.level === 'err' ? '[ERR] ' : '[WARN]';
        console.log(`  ${tag} ${i.msg}`);
      }
    }
    if (allIssues.length) console.log('');
  }

  console.log(`Scanned ${scanned} recipes: ${cleanCount} clean, ${withErrors} with errors, ${withWarnings} with warnings.`);
  console.log(`Total: ${totalErrors} error${totalErrors === 1 ? '' : 's'}, ${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}.`);

  process.exit(totalErrors > 0 ? 1 : 0);
}

main();
