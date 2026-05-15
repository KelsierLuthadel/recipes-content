#!/usr/bin/env node
// Refresh a recipe's hero image with one from Pexels. Finds the recipe by
// title substring (or a directory in bulk mode), moves the current image
// into a sibling `old/` folder (keeping its filename), then downloads
// the top Pexels match into the original path so the existing markdown
// ![](...) link keeps resolving.
//
// Single-recipe mode:
//   PEXELS_API_KEY=xxxx node scripts/refresh-image.mjs "<recipe name>"
//   PEXELS_API_KEY=xxxx node scripts/refresh-image.mjs "<recipe name>" --query "<custom search>"
//
// Bulk mode (every .md under a directory, recursive):
//   PEXELS_API_KEY=xxxx node scripts/refresh-image.mjs --dir cuisine/chinese
//
// In bulk mode each recipe is searched on its own title; recipes whose
// image is already present under old/ are skipped (re-running the same
// dir is safe and doesn't clobber earlier backups).

import { readFileSync, readdirSync, statSync, renameSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, posix, sep, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Match build-manifest.mjs so we walk the same recipe set.
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md']);
// Pexels free tier is 200 req/hr. We use one search + one download per
// recipe (~ 2 req); 500 ms between recipes keeps us well under quota
// and is polite even on paid tiers.
const BULK_DELAY_MS = 500;

function toPosix(p) { return p.split(sep).join(posix.sep); }
function relPath(p) { return toPosix(relative(REPO_ROOT, p)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function extractTitle(md) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function extractFirstImage(md) {
  const m = md.match(/!\[[^\]]*\]\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

// Find recipes by user-supplied query. Resolution order:
//   1. Path substring (only if the query contains a `/`).
//   2. Exact title match (case-insensitive).
//   3. Title substring match (case-insensitive).
// Step 2 lets `"Beef in Oyster Sauce"` resolve to that exact recipe even
// though `"Stir-Fried Beef in Oyster Sauce"` also contains the substring.
function findRecipes(query) {
  const lower = query.toLowerCase();
  const wantsPath = query.includes('/');
  const exact = [];
  const substring = [];
  const pathMatches = [];

  for (const file of walk(REPO_ROOT)) {
    const md = readFileSync(file, 'utf8');
    const title = extractTitle(md);
    if (!title) continue;
    const titleLower = title.toLowerCase();
    const pathLower = toPosix(relative(REPO_ROOT, file)).toLowerCase();

    if (wantsPath && pathLower.includes(lower)) {
      pathMatches.push({ file, title, md });
      continue;
    }
    if (titleLower === lower) exact.push({ file, title, md });
    else if (titleLower.includes(lower)) substring.push({ file, title, md });
  }

  if (wantsPath) return pathMatches;
  if (exact.length) return exact;
  return substring;
}

async function pexelsSearch(query, apiKey) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) {
    throw new Error(`Pexels API ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data.photos || !data.photos.length) {
    throw new Error(`No Pexels results for query: ${query}`);
  }
  return data.photos[0];
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
}

// Returns { ok: true, photo, currentPath, backupPath, recipe } on success,
// or { ok: false, reason: '...' } on any non-fatal failure (caller decides
// whether to abort or continue, depending on single vs. bulk mode).
async function processRecipe(recipe, customQuery, apiKey) {
  const imagePath = extractFirstImage(recipe.md);
  if (!imagePath) return { ok: false, reason: 'no image link in markdown' };
  if (/^https?:/i.test(imagePath)) return { ok: false, reason: `image is a remote URL (${imagePath})` };

  const recipeDir = dirname(recipe.file);
  const currentPath = join(recipeDir, ...imagePath.split('/'));
  if (!existsSync(currentPath)) return { ok: false, reason: `image file missing on disk (${relPath(currentPath)})` };

  // Backups go into a sibling `old/` folder next to the current image,
  // keeping the original filename. Re-running the script on the same
  // recipe is detected by checking that file: if it's already there,
  // we skip rather than overwrite the first backup.
  const oldDir = join(dirname(currentPath), 'old');
  const backupPath = join(oldDir, basename(currentPath));
  if (existsSync(backupPath)) return { ok: false, reason: `backup already exists (${relPath(backupPath)})`, alreadyDone: true };

  const query = customQuery || recipe.title;
  let photo;
  try {
    photo = await pexelsSearch(query, apiKey);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const downloadUrl = photo.src.large2x || photo.src.large || photo.src.original;
  mkdirSync(oldDir, { recursive: true });
  renameSync(currentPath, backupPath);
  try {
    await downloadTo(downloadUrl, currentPath);
  } catch (err) {
    // Roll back the move so we don't leave the recipe with no image.
    try { renameSync(backupPath, currentPath); } catch {}
    return { ok: false, reason: `download failed: ${err.message}` };
  }
  return { ok: true, photo, currentPath, backupPath, recipe };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let recipeName = '';
  let customQuery = null;
  let dirArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query' || args[i] === '-q') customQuery = args[++i];
    else if (args[i] === '--dir' || args[i] === '-d') dirArg = args[++i];
    else recipeName = recipeName ? `${recipeName} ${args[i]}` : args[i];
  }
  return { recipeName: recipeName.trim(), customQuery, dirArg };
}

function resolveDir(dirArg) {
  // Accept absolute paths, paths relative to CWD, or paths relative to the
  // repo root (e.g. "cuisine/chinese" works regardless of where the user
  // invoked the script from).
  if (isAbsolute(dirArg) && existsSync(dirArg)) return dirArg;
  const fromCwd = resolve(process.cwd(), dirArg);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRepo = resolve(REPO_ROOT, dirArg);
  if (existsSync(fromRepo)) return fromRepo;
  return null;
}

async function runBulk(dirArg, customQuery, apiKey) {
  const resolvedDir = resolveDir(dirArg);
  if (!resolvedDir) {
    console.error(`Directory not found: ${dirArg}`);
    process.exit(1);
  }
  const stat = statSync(resolvedDir);
  if (!stat.isDirectory()) {
    console.error(`Not a directory: ${dirArg}`);
    process.exit(1);
  }

  const files = walk(resolvedDir);
  if (!files.length) {
    console.error(`No recipe markdown files found under ${relPath(resolvedDir)}`);
    process.exit(1);
  }

  console.log(`Bulk refresh: ${files.length} recipe${files.length === 1 ? '' : 's'} under ${relPath(resolvedDir)}`);
  console.log('');

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const md = readFileSync(file, 'utf8');
    const title = extractTitle(md);
    if (!title) {
      console.log(`[skip] ${relPath(file)} (no title)`);
      results.push({ file, status: 'skip' });
      continue;
    }
    const recipe = { file, title, md };
    const prefix = `[${i + 1}/${files.length}]`;

    const result = await processRecipe(recipe, customQuery, apiKey);
    if (result.ok) {
      console.log(`${prefix} [ok]   ${title}  ->  ${result.photo.photographer} (${result.photo.url})`);
      results.push({ file, status: 'ok', photo: result.photo, recipe });
    } else if (result.alreadyDone) {
      console.log(`${prefix} [skip] ${title} (already refreshed)`);
      results.push({ file, status: 'skip' });
    } else {
      console.log(`${prefix} [err]  ${title} - ${result.reason}`);
      results.push({ file, status: 'err', reason: result.reason });
    }

    // Throttle between recipes; the last one doesn't need a sleep after.
    if (i < files.length - 1) await sleep(BULK_DELAY_MS);
  }

  const ok = results.filter(r => r.status === 'ok');
  const skip = results.filter(r => r.status === 'skip');
  const err = results.filter(r => r.status === 'err');
  console.log('');
  console.log(`Summary: ${ok.length} refreshed, ${skip.length} skipped, ${err.length} failed.`);
  if (ok.length) {
    console.log('');
    console.log('Suggested credit lines for docs/IMAGE_CREDITS.md:');
    for (const r of ok) {
      console.log(`  ${r.recipe.title}: photo by ${r.photo.photographer} on Pexels (${r.photo.url})`);
    }
  }
}

async function runSingle(recipeName, customQuery, apiKey) {
  const matches = findRecipes(recipeName);
  if (!matches.length) {
    console.error(`No recipe titles contain: "${recipeName}"`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple recipes match "${recipeName}":`);
    for (const m of matches) {
      console.error(`  ${relPath(m.file)}  -  ${m.title}`);
    }
    console.error('Refine the search with a longer / more specific substring.');
    process.exit(1);
  }
  const recipe = matches[0];

  console.log(`Recipe:  ${recipe.title}`);
  console.log(`File:    ${relPath(recipe.file)}`);
  console.log(`Query:   ${customQuery || recipe.title}`);
  console.log('');
  console.log('Searching Pexels...');

  const result = await processRecipe(recipe, customQuery, apiKey);
  if (!result.ok) {
    console.error(`Failed: ${result.reason}`);
    process.exit(1);
  }
  const { photo, currentPath, backupPath } = result;
  console.log(`Found:   ${photo.url}`);
  console.log(`By:      ${photo.photographer} (${photo.photographer_url})`);
  console.log('');
  console.log(`Backed up: ${relPath(backupPath)}`);
  console.log(`Wrote:     ${relPath(currentPath)}`);
  console.log('');
  console.log('Suggested credit line for docs/IMAGE_CREDITS.md:');
  console.log(`  ${recipe.title}: photo by ${photo.photographer} on Pexels (${photo.url})`);
}

async function main() {
  const { recipeName, customQuery, dirArg } = parseArgs(process.argv);

  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.error('PEXELS_API_KEY env var not set.');
    console.error('Set it for this command, e.g. (PowerShell):');
    console.error('  $env:PEXELS_API_KEY="<key>"; node scripts/refresh-image.mjs "<recipe>"');
    process.exit(1);
  }

  if (dirArg) {
    if (recipeName) {
      console.error('Pass either a recipe name or --dir, not both.');
      process.exit(1);
    }
    return runBulk(dirArg, customQuery, apiKey);
  }

  if (!recipeName) {
    console.error('Usage:');
    console.error('  node scripts/refresh-image.mjs "<recipe name>" [--query "<custom search>"]');
    console.error('  node scripts/refresh-image.mjs --dir <path>');
    process.exit(1);
  }

  return runSingle(recipeName, customQuery, apiKey);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
