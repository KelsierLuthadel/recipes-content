#!/usr/bin/env node
// Walk every recipe markdown and bring it to "has an image" state in
// two passes:
//
//   1. If the markdown has no image link, insert
//      "![<Title>](resources/<stem>.jpg)" right after the title.
//   2. If the image link points to a file that's not on disk, search
//      Pexels with the recipe title and download the top result.
//
// Idempotent: recipes with both link and file are skipped.
//
// Usage:
//   node scripts/fetch-missing-images.mjs --add-links-only          # step 1 only, no API needed
//   PEXELS_API_KEY=xxxx node scripts/fetch-missing-images.mjs       # both steps
//   PEXELS_API_KEY=xxxx node scripts/fetch-missing-images.mjs --dir cuisine/british
//
// Pexels free tier is 200 search calls/hour; 600 ms throttle between
// recipes keeps a comfortable margin and the script will say "[err]"
// and continue if a search fails for any reason.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, posix, sep, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO']);
const SKIP_FILES = new Set([
  'README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md',
  'AUTHORING.md', 'CHANGELOG.md',
]);
// Anything starting with TODO is a working note, never a recipe.
const SKIP_PREFIXES = ['TODO'];
const BULK_DELAY_MS = 600;

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
    } else if (entry.endsWith('.md') && !SKIP_FILES.has(entry) && !SKIP_PREFIXES.some(p => entry.startsWith(p))) {
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

// Insert an image link two lines below the H1 title. Preserves whatever
// followed the title (italic context paragraph, meta block, etc.) by
// matching on the title line and slipping the image markdown right
// after it with a blank line on each side.
function insertImageLink(md, title, imageRelPath) {
  const titleRe = /^(#\s+.+?)\s*$/m;
  if (!titleRe.test(md)) return md;
  return md.replace(titleRe, `$1\n\n![${title}](${imageRelPath})`);
}

// Pexels prefers plain noun phrases. Strip parenthetical clarifications
// (which usually clarify for the cook, not the search engine).
function searchQuery(title) {
  return title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function pexelsSearch(query, apiKey) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels API ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data.photos || !data.photos.length) throw new Error(`no Pexels results for "${query}"`);
  return data.photos[0];
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let dir = null;
  let addLinksOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' || args[i] === '-d') dir = args[++i];
    else if (args[i] === '--add-links-only') addLinksOnly = true;
  }
  return { dir, addLinksOnly };
}

function resolveDir(dirArg) {
  if (!dirArg) return REPO_ROOT;
  if (isAbsolute(dirArg) && existsSync(dirArg)) return dirArg;
  const fromCwd = resolve(process.cwd(), dirArg);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRepo = resolve(REPO_ROOT, dirArg);
  if (existsSync(fromRepo)) return fromRepo;
  return null;
}

async function main() {
  const { dir, addLinksOnly } = parseArgs(process.argv);
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey && !addLinksOnly) {
    console.error('PEXELS_API_KEY env var not set.');
    console.error('Either set it, or run with --add-links-only to just patch the markdown:');
    console.error('  node scripts/fetch-missing-images.mjs --add-links-only');
    process.exit(1);
  }

  const root = resolveDir(dir);
  if (!root) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = walk(root);
  console.log(`Scanning ${files.length} recipe${files.length === 1 ? '' : 's'} under ${relPath(root) || '.'}/`);
  if (addLinksOnly) console.log('(--add-links-only: not fetching from Pexels)');
  console.log('');

  // First pass: figure out what each recipe needs and patch the
  // markdown if missing an image link. We do this even in API mode so
  // step 2 has paths to write to.
  const todo = [];
  let linksAdded = 0;

  for (const file of files) {
    let md = readFileSync(file, 'utf8');
    const title = extractTitle(md);
    if (!title) continue;
    let imagePath = extractFirstImage(md);

    if (!imagePath) {
      const stem = basename(file, '.md');
      imagePath = `resources/${stem}.jpg`;
      md = insertImageLink(md, title, imagePath);
      writeFileSync(file, md, 'utf8');
      linksAdded++;
    }

    if (/^https?:/i.test(imagePath)) continue;
    const onDisk = join(dirname(file), ...imagePath.split('/'));
    if (existsSync(onDisk)) continue;

    todo.push({ file, title, imagePath, onDisk });
  }

  if (linksAdded > 0) console.log(`Added ${linksAdded} image link${linksAdded === 1 ? '' : 's'} to markdown.`);
  console.log(`${todo.length} recipe${todo.length === 1 ? '' : 's'} need image files.`);
  if (addLinksOnly) return;

  console.log('');
  let okCount = 0;
  let errCount = 0;
  const credits = [];

  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    const query = searchQuery(t.title);
    const prefix = `[${i + 1}/${todo.length}]`;
    try {
      const photo = await pexelsSearch(query, apiKey);
      const url = photo.src.large2x || photo.src.large || photo.src.original;
      mkdirSync(dirname(t.onDisk), { recursive: true });
      await downloadTo(url, t.onDisk);
      console.log(`${prefix} [ok]   ${t.title}  ->  ${photo.photographer}`);
      credits.push({ title: t.title, photo });
      okCount++;
    } catch (err) {
      console.log(`${prefix} [err]  ${t.title} - ${err.message}`);
      errCount++;
    }
    if (i < todo.length - 1) await sleep(BULK_DELAY_MS);
  }

  console.log('');
  console.log(`Summary: ${okCount} downloaded, ${errCount} failed.`);
  if (credits.length) {
    console.log('');
    console.log('Credits for docs/IMAGE_CREDITS.md:');
    for (const c of credits) {
      console.log(`  ${c.title}: photo by ${c.photo.photographer} on Pexels (${c.photo.url})`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
