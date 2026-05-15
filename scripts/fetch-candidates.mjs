#!/usr/bin/env node
// Find recipe hero images under a width threshold and stage N Pexels
// candidates for each, so you can browse the options and pick the best
// before manually promoting one over the original. The original image is
// left untouched; nothing under markdown/manifest changes.
//
// Candidates land at:
//   <recipe-dir>/resources/candidates/<basename-stem>/<basename-stem>-N<ext>
//
// `resources/` is already skipped by the manifest walker (build-manifest.mjs
// SKIP_DIRS), so candidates folders are invisible to the site.
//
// Usage:
//   PEXELS_API_KEY=xxxx node scripts/fetch-candidates.mjs
//   PEXELS_API_KEY=xxxx node scripts/fetch-candidates.mjs --max-width 500 --count 3
//   PEXELS_API_KEY=xxxx node scripts/fetch-candidates.mjs --dry-run
//
// Re-running skips recipes whose candidates folder already has at least
// `--count` files, so you can interrupt and resume safely.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, posix, sep, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md']);
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

// Header-only image dimension reader. JPEG / PNG / WebP without deps.
// Mirrors the parser in scripts/audit-images.mjs; kept inline so this
// script stays self-contained.
function parseDims(buf) {
  if (buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xFF) return null;
      let marker = buf[i + 1];
      while (marker === 0xFF && i + 2 < buf.length) { i++; marker = buf[i + 1]; }
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (i + 9 > buf.length) return null;
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
    return null;
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const tag = buf.toString('ascii', 12, 16);
    if (tag === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
    }
    if (tag === 'VP8L') {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return {
        width: 1 + ((b0 | (b1 << 8)) & 0x3FFF),
        height: 1 + ((((b1 >> 6) | (b2 << 2) | (b3 << 10))) & 0x3FFF),
      };
    }
    if (tag === 'VP8X') {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
  }
  return null;
}

async function pexelsSearch(query, count, apiKey) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels API ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data.photos || !data.photos.length) throw new Error(`no Pexels results for "${query}"`);
  return data.photos;
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let maxWidth = 500;
  let count = 3;
  let dryRun = false;
  let customQuery = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-width') maxWidth = Number(args[++i]);
    else if (args[i] === '--count') count = Number(args[++i]);
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--query' || args[i] === '-q') customQuery = args[++i];
  }
  return { maxWidth, count, dryRun, customQuery };
}

async function main() {
  const { maxWidth, count, dryRun, customQuery } = parseArgs(process.argv);

  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey && !dryRun) {
    console.error('PEXELS_API_KEY env var not set.');
    console.error('Run with --dry-run first to preview, or set the key, e.g. (PowerShell):');
    console.error('  $env:PEXELS_API_KEY="<key>"; node scripts/fetch-candidates.mjs');
    process.exit(1);
  }

  // Pass 1: scan every recipe, keep the ones whose hero is under maxWidth.
  const targets = [];
  for (const file of walk(REPO_ROOT)) {
    const md = readFileSync(file, 'utf8');
    const title = extractTitle(md);
    if (!title) continue;
    const imagePath = extractFirstImage(md);
    if (!imagePath || /^https?:/i.test(imagePath)) continue;
    const onDisk = join(dirname(file), ...imagePath.split('/'));
    if (!existsSync(onDisk)) continue;

    let dims = null;
    try { dims = parseDims(readFileSync(onDisk)); } catch { /* skip */ }
    if (!dims || dims.width >= maxWidth) continue;

    targets.push({ file, title, onDisk, width: dims.width, height: dims.height });
  }

  console.log(`Found ${targets.length} recipe${targets.length === 1 ? '' : 's'} with hero image width < ${maxWidth}px.`);
  console.log(`Will stage ${count} candidate${count === 1 ? '' : 's'} per recipe under <recipe>/resources/candidates/<stem>/.`);
  if (dryRun) console.log('(dry run; no API calls, no files written)');
  console.log('');

  if (!targets.length) return;

  const credits = [];
  let okCount = 0, skipCount = 0, errCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const ext = extname(t.onDisk);
    const stem = basename(t.onDisk, ext);
    const candidatesDir = join(dirname(t.onDisk), 'candidates', stem);
    const prefix = `[${i + 1}/${targets.length}]`;

    // Skip if we already have enough candidates from a previous run.
    if (existsSync(candidatesDir)) {
      const existing = readdirSync(candidatesDir).filter(n => n.startsWith(`${stem}-`)).length;
      if (existing >= count) {
        console.log(`${prefix} [skip] ${t.title} (already has ${existing} candidates)`);
        skipCount++;
        continue;
      }
    }

    // Pexels search is a plain text matcher; parenthetical English
    // glosses ("(Confectioners' custard)") and stray quotes hurt the
    // results, so strip them when the query is auto-derived.
    const query = customQuery || t.title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (dryRun) {
      console.log(`${prefix} [plan] ${t.title} (${t.width} x ${t.height})  query: "${query}"`);
      console.log(`         -> ${relPath(candidatesDir)}/`);
      continue;
    }

    let photos;
    try {
      photos = await pexelsSearch(query, count, apiKey);
    } catch (err) {
      console.log(`${prefix} [err]  ${t.title} - ${err.message}`);
      errCount++;
      if (i < targets.length - 1) await sleep(BULK_DELAY_MS);
      continue;
    }

    mkdirSync(candidatesDir, { recursive: true });
    let saved = 0;
    for (let j = 0; j < photos.length; j++) {
      const photo = photos[j];
      const url = photo.src.large2x || photo.src.large || photo.src.original;
      const dest = join(candidatesDir, `${stem}-${j + 1}${ext}`);
      try {
        await downloadTo(url, dest);
        saved++;
        credits.push({ title: t.title, n: j + 1, photo });
      } catch (err) {
        console.log(`         download ${j + 1} failed: ${err.message}`);
      }
    }
    console.log(`${prefix} [ok]   ${t.title} (${t.width} x ${t.height})  staged ${saved}/${photos.length}  -> ${relPath(candidatesDir)}/`);
    if (saved > 0) okCount++;
    else errCount++;

    if (i < targets.length - 1) await sleep(BULK_DELAY_MS);
  }

  if (dryRun) return;

  console.log('');
  console.log(`Summary: ${okCount} staged, ${skipCount} skipped, ${errCount} failed.`);
  if (credits.length) {
    console.log('');
    console.log('Credits (use whichever -N you pick):');
    for (const c of credits) {
      console.log(`  ${c.title} #${c.n}: ${c.photo.photographer} (${c.photo.url})`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
