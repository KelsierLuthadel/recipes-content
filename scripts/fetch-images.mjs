#!/usr/bin/env node
// Finds and (optionally) downloads Unsplash images for recipes that are missing one.
//
// Required env: UNSPLASH_ACCESS_KEY
//
// Usage:
//   node scripts/fetch-images.mjs                # dry-run: print proposed match per recipe
//   node scripts/fetch-images.mjs --apply        # download + patch markdown + write credits
//   node scripts/fetch-images.mjs --max 5        # limit to first N (handy for testing)
//   node scripts/fetch-images.mjs --filter <re>  # only recipes whose path matches regex
//
// What --apply does for each recipe:
//   1. fetches the chosen photo (regular size) into <recipe-dir>/resources/<slug>.jpg
//   2. triggers the Unsplash download_location endpoint (required by their API guidelines)
//   3. inserts `![Title](resources/<slug>.jpg)` two lines below the H1 in the recipe markdown
//   4. appends an attribution row to docs/IMAGE_CREDITS.md

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/recipes.json'), 'utf8'));
const CREDITS_PATH = join(REPO_ROOT, 'docs/IMAGE_CREDITS.md');
const CANDIDATES_PATH = join(REPO_ROOT, 'scripts/image-candidates.json');
const PREVIEW_PATH = join(REPO_ROOT, 'scripts/image-preview.html');

const args = parseArgs(process.argv.slice(2));
const APPLY = args.has('--apply');
const MAX = args.flag('--max', null) ? Number(args.flag('--max')) : null;
const FILTER = args.flag('--filter', null);

const KEY = process.env.UNSPLASH_ACCESS_KEY
  || readKeyFile('unsplash')
  || readKeyFile('.env', 'UNSPLASH_ACCESS_KEY');
if (!KEY) {
  console.error('No Unsplash key found. Set UNSPLASH_ACCESS_KEY, or save the key to ./unsplash, or put UNSPLASH_ACCESS_KEY=... in ./.env.');
  process.exit(1);
}

function readKeyFile(filename, name = null) {
  const p = join(REPO_ROOT, filename);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, 'utf8').trim();
  if (!content) return null;
  if (!name) {
    // single-line key file: take the first non-empty line, strip optional KEY= prefix
    const line = content.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!line) return null;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+?)$/i);
    return m ? m[2].replace(/^['"]|['"]$/g, '') : line.replace(/^['"]|['"]$/g, '');
  }
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/i);
    if (m && m[1] === name) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

const APP_NAME = 'recipes-site';
const UTM = `utm_source=${APP_NAME}&utm_medium=referral`;

// ---------- 1. find recipes missing an image ----------

const missing = [];
const visit = (node) => {
  for (const r of node.recipes || []) if (!r.image) missing.push(r);
  for (const c of node.subcategories || []) visit(c);
};
for (const c of MANIFEST.categories) visit(c);

let work = missing;
if (FILTER) {
  const re = new RegExp(FILTER, 'i');
  work = work.filter(r => re.test(r.path));
}
if (MAX) work = work.slice(0, MAX);

console.log(`${missing.length} recipes missing images`);
if (work.length !== missing.length) console.log(`processing ${work.length} after filter/max`);
console.log(APPLY ? 'mode: APPLY (will download)' : 'mode: dry-run');
console.log('');

// ---------- 2. derive a search query from each recipe ----------

function searchQueries(recipe) {
  let title = (recipe.title || '')
    .replace(/^mowgli\s+/i, '')        // chef name, not food
    .replace(/\s*\([^)]*\)\s*/g, ' ')  // strip parentheticals
    .replace(/\s+/g, ' ')
    .trim();

  const segments = recipe.path.split('/').slice(0, -1);
  const cuisineIdx = segments.indexOf('cuisine');
  const cuisine = (cuisineIdx >= 0 && segments[cuisineIdx + 1]) ? segments[cuisineIdx + 1] : null;

  const queries = [];
  if (cuisine) queries.push(`${title} ${cuisine}`);
  queries.push(title);
  if (cuisine) queries.push(`${cuisine} ${title} food`);
  queries.push(`${title} dish`);
  // de-dup, preserve order
  return [...new Set(queries.map(q => q.toLowerCase()))].map(q => q.trim()).filter(Boolean);
}

// ---------- 3. unsplash search ----------

async function search(q) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=10&orientation=landscape&content_filter=low`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${KEY}`,
      'Accept-Version': 'v1',
    },
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.results || [];
}

const usedPhotoIds = new Set();

async function pickPhoto(recipe) {
  const queries = searchQueries(recipe);
  let lastTried = null;
  for (const q of queries) {
    lastTried = q;
    const results = await search(q);
    for (const r of results) {
      if (!usedPhotoIds.has(r.id)) {
        usedPhotoIds.add(r.id);
        return { photo: r, query: q };
      }
    }
  }
  return { photo: null, query: lastTried };
}

// ---------- 4. apply: download and patch ----------

function fileExtFromUrl(u) {
  const m = u.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

async function pingDownload(downloadLocation) {
  // Unsplash requires us to call this when the user "selects" the image
  await fetch(`${downloadLocation}&client_id=${KEY}`);
}

function patchMarkdown(absMdPath, imageRel, title) {
  const md = readFileSync(absMdPath, 'utf8');
  // already has an image reference?
  if (/!\[[^\]]*\]\([^)]+\)/.test(md)) {
    return { changed: false, reason: 'markdown already references an image' };
  }
  const lines = md.split(/\r?\n/);
  const h1Idx = lines.findIndex(l => /^#\s+/.test(l));
  if (h1Idx < 0) return { changed: false, reason: 'no H1 found' };
  const altText = title.replace(/[\[\]]/g, '');
  const insertion = ['', `![${altText}](${imageRel})`, ''];
  lines.splice(h1Idx + 1, 0, ...insertion);
  writeFileSync(absMdPath, lines.join('\n'), 'utf8');
  return { changed: true };
}

function localImagePathFor(recipePath, urlRegular) {
  const baseSlug = recipePath.split('/').pop().replace(/\.md$/, '');
  const ext = fileExtFromUrl(urlRegular);
  const filename = `${baseSlug}${ext}`;
  const recipeDir = dirname(join(REPO_ROOT, recipePath));
  return { absImage: join(recipeDir, 'resources', filename), imageRel: `resources/${filename}` };
}

// Idempotent: skips download if the image is already present, skips markdown
// patch if it already references an image. Safe to call repeatedly.
async function applyCandidate(recipe, c) {
  const { absImage, imageRel } = localImagePathFor(recipe.path, c.urlRegular);
  const resourcesDir = dirname(absImage);
  if (!existsSync(resourcesDir)) mkdirSync(resourcesDir, { recursive: true });

  let downloaded = false;
  if (!existsSync(absImage)) {
    await downloadTo(c.urlRegular, absImage);
    if (c.downloadLocation) await pingDownload(c.downloadLocation);
    downloaded = true;
  }

  const patch = patchMarkdown(join(REPO_ROOT, recipe.path), imageRel, recipe.title);
  return { downloaded, patched: patch.changed, patchReason: patch.reason };
}

function writeCreditsFile(candidates) {
  const header = '# Image credits\n\n' +
    'Recipe photography sourced from [Unsplash](https://unsplash.com/?' + UTM + '). All photographers retain rights to their work.\n\n' +
    '| Recipe | Photographer | Source |\n' +
    '| --- | --- | --- |\n';
  const rows = Object.values(candidates)
    .sort((a, b) => a.recipePath.localeCompare(b.recipePath))
    .map(c => {
      const userUrl = `${c.photographerUrl}?${UTM}`;
      const photoUrl = `${c.photoPage}?${UTM}`;
      return `| [${c.title}](../${c.recipePath}) | [${c.photographer}](${userUrl}) | [Unsplash](${photoUrl}) |`;
    })
    .join('\n');
  writeFileSync(CREDITS_PATH, header + rows + '\n', 'utf8');
}

// ---------- 5. main loop ----------

// load any existing candidates so we can resume after a rate-limit hit
let candidates = {};
if (existsSync(CANDIDATES_PATH)) {
  try { candidates = JSON.parse(readFileSync(CANDIDATES_PATH, 'utf8')); }
  catch { candidates = {}; }
  for (const id of Object.values(candidates).map(c => c.photoId).filter(Boolean)) usedPhotoIds.add(id);
}

let okCount = 0;
let skipCount = 0;
let failCount = 0;
const skipped = [];

for (const recipe of work) {
  // 1. find a candidate (from cache, or freshly searched)
  let c = candidates[recipe.path];
  let fromCache = !!c && !args.has('--refresh');

  if (!fromCache) {
    process.stdout.write(`  ${recipe.path}  ... `);
    let pick, query;
    try {
      const r = await pickPhoto(recipe);
      pick = r.photo;
      query = r.query;
    } catch (err) {
      console.log('SEARCH FAILED:', err.message);
      failCount++;
      continue;
    }
    if (!pick) {
      console.log(`no usable results (last query: "${query}")`);
      skipped.push({ recipe: recipe.path, reason: 'no usable results', query });
      skipCount++;
      continue;
    }
    c = {
      recipePath: recipe.path,
      title: recipe.title,
      query,
      photoId: pick.id,
      photographer: pick.user.name,
      photographerUrl: pick.user.links.html,
      photoPage: pick.links.html,
      downloadLocation: pick.links.download_location,
      urlRegular: pick.urls.regular,
      urlThumb: pick.urls.thumb,
      description: pick.description || pick.alt_description || '',
    };
    candidates[recipe.path] = c;
    writeFileSync(CANDIDATES_PATH, JSON.stringify(candidates, null, 2));
    console.log(`pick: ${c.photoId}  by ${c.photographer}  (q: "${c.query}")`);
  } else {
    console.log(`  ${recipe.path}  (cached) pick: ${c.photoId} by ${c.photographer}`);
  }

  // 2. apply (download + patch) when --apply, idempotently
  if (APPLY) {
    try {
      const r = await applyCandidate(recipe, c);
      const notes = [];
      if (!r.downloaded) notes.push('image already present');
      if (!r.patched) notes.push(`markdown not patched: ${r.patchReason}`);
      if (notes.length) console.log(`         ${notes.join('; ')}`);
      okCount++;
    } catch (err) {
      console.log(`         APPLY FAILED: ${err.message}`);
      failCount++;
    }
  } else {
    if (!fromCache) console.log(`         ${c.photoPage}`);
    okCount++;
  }

  // gentle throttle only matters when we actually called the API
  if (!fromCache) await sleep(250);
}

if (APPLY) writeCreditsFile(candidates);

console.log('');
console.log(`done: ${okCount} matched, ${skipCount} skipped, ${failCount} failed`);
if (skipped.length) {
  console.log('\nskipped recipes:');
  for (const s of skipped) console.log(`  ${s.recipe}  (${s.reason}; query: "${s.query}")`);
}

writePreview(candidates);

if (APPLY) {
  console.log(`\ncredits written to docs/IMAGE_CREDITS.md`);
  console.log(`now run: node scripts/build-manifest.mjs`);
} else {
  console.log(`\ncandidates saved to ${CANDIDATES_PATH}`);
  console.log(`preview: open ${PREVIEW_PATH} in a browser to review picks`);
  console.log(`run again to resume after a rate-limit hit; cached picks won't re-search`);
  console.log(`run with --apply to download and patch markdown for everything in candidates`);
}

function writePreview(cands) {
  const rows = Object.values(cands).map(c => `
    <tr>
      <td><img src="${c.urlThumb}" alt="" width="200" height="150" loading="lazy"></td>
      <td>
        <strong>${escape(c.title)}</strong>
        <div class="path">${escape(c.recipePath)}</div>
        <div class="query">query: "${escape(c.query)}"</div>
        <div class="desc">${escape(c.description || '-')}</div>
        <div class="links">
          <a href="${escape(c.photoPage)}" target="_blank" rel="noopener">photo</a>
          &middot;
          <a href="${escape(c.photographerUrl)}" target="_blank" rel="noopener">${escape(c.photographer)}</a>
        </div>
      </td>
    </tr>`).join('\n');

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Image candidates preview</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 2rem; max-width: 1100px; margin: 0 auto; color: #1c1917; }
  h1 { font-size: 1.5rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 0.75rem; border-bottom: 1px solid #e5e5e5; }
  img { display: block; border-radius: 6px; object-fit: cover; }
  .path, .query, .desc, .links { font-size: 0.85rem; color: #57534e; margin-top: 0.25rem; }
  .query { font-family: ui-monospace, monospace; }
  .desc { font-style: italic; }
  a { color: #5b6e3a; }
</style>
<h1>${Object.keys(cands).length} image candidates</h1>
<p>Open in a browser. To reject one, delete its row from <code>scripts/image-candidates.json</code> and re-run with <code>--apply</code>.</p>
<table>${rows}</table>
`;
  writeFileSync(PREVIEW_PATH, html, 'utf8');
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- helpers ----------

function parseArgs(argv) {
  const set = new Set();
  const map = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        map.set(a, next);
        i++;
      } else {
        set.add(a);
      }
    }
  }
  return {
    has: (k) => set.has(k) || map.has(k),
    flag: (k, def) => map.has(k) ? map.get(k) : def,
  };
}
