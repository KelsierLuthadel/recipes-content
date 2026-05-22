#!/usr/bin/env node
// Fetches Unsplash images for the new tutorial pages (Thai curry, French
// patisserie, pasta). Each tutorial markdown references an image at a
// known relative path; this script searches Unsplash for an appropriate
// hero shot, downloads it to that path, and stops.
//
// Required env: UNSPLASH_ACCESS_KEY (or ./unsplash file at repo root).
//
// Usage:
//   node scripts/fetch-tutorial-images.mjs              # dry-run
//   node scripts/fetch-tutorial-images.mjs --apply      # download
//   node scripts/fetch-tutorial-images.mjs --apply --force  # re-download even if exists
//
// Does NOT modify markdown (paths already correct) and does NOT write
// IMAGE_CREDITS.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const FORCE = args.has('--force');

const KEY = process.env.UNSPLASH_ACCESS_KEY || readKeyFile('unsplash');
if (!KEY) {
  console.error('Set UNSPLASH_ACCESS_KEY or save the key in ./unsplash');
  process.exit(1);
}

function readKeyFile(filename) {
  const p = join(REPO_ROOT, filename);
  if (!existsSync(p)) return null;
  const line = readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (!line) return null;
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+?)$/i);
  return m ? m[2].replace(/^['"]|['"]$/g, '') : line.replace(/^['"]|['"]$/g, '');
}

// Each entry: target image path (relative to repo root) + search queries
// (tried in order until one finds a usable photo).
const TARGETS = [
  // Thai curry course
  { path: 'tutorials/thai-curry/resources/course.jpg', queries: ['thai curry bowl', 'thai curry plate'] },
  { path: 'tutorials/thai-curry/resources/green.jpg', queries: ['thai green curry chicken', 'thai green curry'] },
  { path: 'tutorials/thai-curry/resources/red.jpg', queries: ['thai red curry duck', 'thai red curry beef', 'thai red curry'] },
  { path: 'tutorials/thai-curry/resources/yellow.jpg', queries: ['thai yellow curry chicken', 'thai yellow curry'] },
  { path: 'tutorials/thai-curry/resources/massaman.jpg', queries: ['massaman curry beef', 'massaman curry'] },
  { path: 'tutorials/thai-curry/resources/panang.jpg', queries: ['panang curry beef', 'panang curry'] },
  { path: 'tutorials/thai-curry/resources/coconut-milk.jpg', queries: ['coconut milk pouring', 'thai curry cooking pan'] },
  { path: 'tutorials/thai-curry/resources/building.jpg', queries: ['thai green curry chicken plated', 'thai curry rice bowl'] },

  // Patisserie course
  { path: 'tutorials/patisserie/resources/course.jpg', queries: ['french patisserie display', 'french patisserie counter'] },
  { path: 'tutorials/patisserie/resources/composing.jpg', queries: ['plated french dessert', 'composed dessert plate'] },
  { path: 'tutorials/patisserie/resources/cakes.jpg', queries: ['mille feuille dessert', 'opera cake'] },
  { path: 'tutorials/patisserie/resources/tarts.jpg', queries: ['lemon tart french', 'tarte au citron'] },
  { path: 'tutorials/patisserie/resources/petit-fours.jpg', queries: ['french macarons tray', 'french petit fours'] },
  { path: 'tutorials/patisserie/resources/set-creams.jpg', queries: ['creme brulee torched', 'creme brulee'] },

  // Pasta course
  { path: 'tutorials/pasta/resources/course.jpg', queries: ['fresh italian pasta hanging', 'fresh tagliatelle italian'] },
  { path: 'tutorials/pasta/resources/dough.jpg', queries: ['rolling pasta dough', 'pasta dough flour eggs'] },
  { path: 'tutorials/pasta/resources/shapes.jpg', queries: ['italian pasta shapes variety', 'fresh ravioli pasta'] },
  { path: 'tutorials/pasta/resources/dried.jpg', queries: ['dried pasta penne italian', 'dried pasta variety'] },
  { path: 'tutorials/pasta/resources/matching.jpg', queries: ['bucatini carbonara', 'spaghetti carbonara plate'] },
  { path: 'tutorials/pasta/resources/regional.jpg', queries: ['italian ragu pasta bolognese', 'tagliatelle bolognese'] },
];

const usedPhotoIds = new Set();

async function search(q) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=10&orientation=landscape&content_filter=high`;
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${KEY}`, 'Accept-Version': 'v1' },
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.results || [];
}

async function pickPhoto(queries) {
  for (const q of queries) {
    const results = await search(q);
    for (const r of results) {
      if (!usedPhotoIds.has(r.id)) {
        usedPhotoIds.add(r.id);
        return { photo: r, query: q };
      }
    }
  }
  return null;
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

async function pingDownload(downloadLocation) {
  await fetch(`${downloadLocation}&client_id=${KEY}`);
}

console.log(`${TARGETS.length} tutorial images to consider`);
console.log(APPLY ? `mode: APPLY${FORCE ? ' (force)' : ''}` : 'mode: dry-run');
console.log('');

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const t of TARGETS) {
  const dest = join(REPO_ROOT, t.path);
  if (existsSync(dest) && !FORCE) {
    console.log(`SKIP (exists): ${t.path}`);
    skipped++;
    continue;
  }

  let pick;
  try {
    pick = await pickPhoto(t.queries);
  } catch (e) {
    console.log(`FAIL: ${t.path} - ${e.message}`);
    failed++;
    continue;
  }

  if (!pick) {
    console.log(`NO MATCH: ${t.path} - queries: ${t.queries.join(' | ')}`);
    failed++;
    continue;
  }

  const { photo, query } = pick;
  console.log(`${APPLY ? 'GET' : 'DRY'}: ${t.path}`);
  console.log(`     query: ${query}`);
  console.log(`     photo: ${photo.urls.regular}`);
  console.log(`     by:    ${photo.user.name} (https://unsplash.com/@${photo.user.username})`);

  if (APPLY) {
    try {
      await downloadTo(photo.urls.regular, dest);
      await pingDownload(photo.links.download_location);
      downloaded++;
    } catch (e) {
      console.log(`FAIL download: ${e.message}`);
      failed++;
    }
    // Stay polite to Unsplash rate limits.
    await sleep(400);
  }
  console.log('');
}

console.log(`Done. downloaded: ${downloaded}, skipped: ${skipped}, failed: ${failed}`);
