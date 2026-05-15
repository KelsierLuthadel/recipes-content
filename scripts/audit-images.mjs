#!/usr/bin/env node
// Audit recipe hero images: file size + pixel dimensions, sorted ascending
// so the smallest (most upgrade-worthy) appear first. Dimensions are parsed
// from the file header for JPEG, PNG, and WebP without any deps.
//
// Usage:
//   node scripts/audit-images.mjs                              # show worst 30
//   node scripts/audit-images.mjs --max-width 1000             # only show images under N px wide
//   node scripts/audit-images.mjs --max-kb 60                  # only show files under N KB
//   node scripts/audit-images.mjs --limit 50                   # change the row cap
//   node scripts/audit-images.mjs --max-width 800 --max-kb 80  # combine filters

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

function extractTitle(md) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}
function extractFirstImage(md) {
  const m = md.match(/!\[[^\]]*\]\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

// Header-only readers. We slurp the whole file (most are < 1 MB), simpler
// than streaming and the script is one-shot. Returns { width, height } or
// null if the format isn't recognised.
function parseDims(buf) {
  if (buf.length < 16) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }
  // JPEG: FF D8
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xFF) return null;
      let marker = buf[i + 1];
      // Skip filler 0xFF bytes between markers.
      while (marker === 0xFF && i + 2 < buf.length) { i++; marker = buf[i + 1]; }
      // SOFn (start of frame) markers carry the dimensions.
      // Excludes DHT (C4), JPG (C8), DAC (CC) which aren't SOFs.
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (i + 9 > buf.length) return null;
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' };
      }
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
    return null;
  }
  // WebP: RIFF....WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const tag = buf.toString('ascii', 12, 16);
    if (tag === 'VP8 ') {
      // VP8 lossy: dimensions at offset 26 / 28 (14 bits each, little-endian).
      const w = buf.readUInt16LE(26) & 0x3FFF;
      const h = buf.readUInt16LE(28) & 0x3FFF;
      return { width: w, height: h, format: 'webp' };
    }
    if (tag === 'VP8L') {
      // VP8L lossless: 14-bit width-1 / height-1 packed across bytes 21-24.
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const w = 1 + ((b0 | (b1 << 8)) & 0x3FFF);
      const h = 1 + ((((b1 >> 6) | (b2 << 2) | (b3 << 10))) & 0x3FFF);
      return { width: w, height: h, format: 'webp' };
    }
    if (tag === 'VP8X') {
      // Extended: canvas size at offset 24 / 27 (3 bytes each, little-endian, value+1).
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h, format: 'webp' };
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let maxWidth = null;
  let maxKb = null;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-width') maxWidth = Number(args[++i]);
    else if (args[i] === '--max-kb') maxKb = Number(args[++i]);
    else if (args[i] === '--limit') limit = Number(args[++i]);
  }
  return { maxWidth, maxKb, limit };
}

function main() {
  const { maxWidth, maxKb, limit } = parseArgs(process.argv);

  const rows = [];
  for (const file of walk(REPO_ROOT)) {
    const md = readFileSync(file, 'utf8');
    const title = extractTitle(md);
    if (!title) continue;
    const imagePath = extractFirstImage(md);
    if (!imagePath || /^https?:/i.test(imagePath)) continue;
    const onDisk = join(dirname(file), ...imagePath.split('/'));
    if (!existsSync(onDisk)) continue;

    const sizeBytes = statSync(onDisk).size;
    let dims = null;
    try {
      const buf = readFileSync(onDisk);
      dims = parseDims(buf);
    } catch { /* unreadable - skip dims */ }

    rows.push({
      recipe: relPath(file),
      title,
      image: relPath(onDisk),
      sizeKb: sizeBytes / 1024,
      width: dims ? dims.width : null,
      height: dims ? dims.height : null,
    });
  }

  // Apply optional filters.
  let filtered = rows;
  if (maxWidth != null) filtered = filtered.filter(r => r.width != null && r.width < maxWidth);
  if (maxKb != null) filtered = filtered.filter(r => r.sizeKb < maxKb);

  // Sort smallest first by a composite score: width and KB together, with
  // unparseable widths treated as huge so they sort to the bottom.
  filtered.sort((a, b) => {
    const aw = a.width || 99999;
    const bw = b.width || 99999;
    if (aw !== bw) return aw - bw;
    return a.sizeKb - b.sizeKb;
  });

  const shown = filtered.slice(0, limit);
  if (!shown.length) {
    console.log(`No images matched the filters (scanned ${rows.length}).`);
    return;
  }

  console.log(`Showing ${shown.length} of ${filtered.length} matching image${filtered.length === 1 ? '' : 's'} (of ${rows.length} scanned). Worst first.`);
  console.log('');
  console.log('  W x H        size   recipe');
  console.log('  ---------    ----   ----------------------------------------');
  for (const r of shown) {
    const dims = r.width ? `${r.width} x ${r.height}`.padEnd(11) : '? x ?      ';
    const size = `${r.sizeKb.toFixed(0).padStart(4)}KB`;
    console.log(`  ${dims}  ${size}   ${r.title}`);
    console.log(`                       ${r.image}`);
  }
}

main();
