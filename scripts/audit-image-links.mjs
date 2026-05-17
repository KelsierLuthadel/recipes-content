#!/usr/bin/env node
// One-off: find recipe markdown files whose image file exists on disk
// but whose markdown body has no ![](resources/...) link. Inserts the
// link in place when the hero image is found, reports the case where
// only a thumb exists (someone deleted the hero and left the thumb).
//
// Delete this script after running; it's a maintenance helper, not
// committed automation.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO', 'editorial']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md', 'AUTHORING.md', 'CHANGELOG.md']);
const EXTS = ['jpg', 'jpeg', 'png', 'webp'];

function toPosix(p) { return p.split(sep).join(posix.sep); }
function rel(p) { return toPosix(relative(REPO_ROOT, p)); }

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      if (entry.startsWith('.')) continue;
      walk(full, files);
    } else if (entry.endsWith('.md') && !SKIP_FILES.has(entry) && !entry.startsWith('TODO')) {
      files.push(full);
    }
  }
  return files;
}

function extractTitle(md) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function hasImageLink(md) {
  return /!\[[^\]]*\]\(([^)]+)\)/.test(md);
}

function findExtIn(dir, stem) {
  for (const ext of EXTS) {
    if (existsSync(join(dir, `${stem}.${ext}`))) return ext;
  }
  return null;
}

// Insert "![title](resources/stem.ext)" two lines below the H1, matching
// the rest of the catalogue's hero-line placement.
function insertImageLink(md, title, relImagePath) {
  return md.replace(/^(#\s+.+?)\s*$/m, `$1\n\n![${title}](${relImagePath})`);
}

const files = walk(REPO_ROOT);
let fixed = 0;
let thumbOnly = 0;
let noImage = 0;
let already = 0;

for (const file of files) {
  const md = readFileSync(file, 'utf8');
  if (hasImageLink(md)) { already++; continue; }
  const title = extractTitle(md);
  if (!title) continue;

  const stem = basename(file, '.md');
  const dir = dirname(file);
  const heroExt = findExtIn(join(dir, 'resources'), stem);

  if (heroExt) {
    const newMd = insertImageLink(md, title, `resources/${stem}.${heroExt}`);
    writeFileSync(file, newMd, 'utf8');
    fixed++;
    console.log(`[fix]        ${rel(file)}  ←  resources/${stem}.${heroExt}`);
    continue;
  }

  const thumbExt = findExtIn(join(dir, 'resources', 'thumbs'), stem);
  if (thumbExt) {
    thumbOnly++;
    console.log(`[thumb only] ${rel(file)}  (thumb exists, hero missing)`);
  } else {
    noImage++;
  }
}

console.log('');
console.log(`Already linked: ${already}`);
console.log(`Fixed:          ${fixed}`);
console.log(`Thumb-only:     ${thumbOnly}  (hero needs to be supplied)`);
console.log(`No image:       ${noImage}`);
