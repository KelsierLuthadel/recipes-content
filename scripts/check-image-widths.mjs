#!/usr/bin/env node
// Scan every recipe image and report which are wider than the threshold.
//   node scripts/check-image-widths.mjs [threshold=800]
// Reads JPEG SOF / PNG IHDR headers directly; no dependencies.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'old', 'documentation', 'TODO']);
const THRESHOLD = parseInt(process.argv[2] || '800', 10);

function toPosix(p) { return p.split(sep).join(posix.sep); }

function jpegSize(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1];
    i += 2;
    if (
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF)
    ) {
      const height = (buf[i + 3] << 8) | buf[i + 4];
      const width = (buf[i + 5] << 8) | buf[i + 6];
      return { width, height };
    }
    if (marker === 0xD8 || marker === 0xD9) return null;
    const segLen = (buf[i] << 8) | buf[i + 1];
    i += segLen;
  }
  return null;
}

function pngSize(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(REPO_ROOT);
const wide = [];
const narrow = [];
const broken = [];

for (const f of files) {
  try {
    const buf = readFileSync(f);
    const isPng = /\.png$/i.test(f);
    const dim = isPng ? pngSize(buf) : jpegSize(buf);
    if (!dim) { broken.push(f); continue; }
    const entry = {
      path: toPosix(relative(REPO_ROOT, f)),
      w: dim.width,
      h: dim.height,
      kb: Math.round(buf.length / 1024),
    };
    if (dim.width >= THRESHOLD) wide.push(entry);
    else narrow.push(entry);
  } catch {
    broken.push(f);
  }
}

console.log(`Total images: ${files.length}`);
console.log(`>= ${THRESHOLD}px wide: ${wide.length}`);
console.log(`< ${THRESHOLD}px wide: ${narrow.length}`);
console.log(`Unreadable: ${broken.length}`);
console.log();

console.log(`=== >= ${THRESHOLD}px wide (${wide.length}) ===`);
wide.sort((a, b) => b.w - a.w);
for (const e of wide) console.log(`  ${String(e.w).padStart(5)}x${String(e.h).padStart(5)}  ${String(e.kb).padStart(5)}KB  ${e.path}`);

console.log();
console.log(`=== < ${THRESHOLD}px wide (${narrow.length}) ===`);
narrow.sort((a, b) => a.w - b.w);
for (const e of narrow) console.log(`  ${String(e.w).padStart(5)}x${String(e.h).padStart(5)}  ${String(e.kb).padStart(5)}KB  ${e.path}`);

if (broken.length) {
  console.log();
  console.log(`=== Unreadable (${broken.length}) ===`);
  for (const f of broken) console.log(`  ${toPosix(relative(REPO_ROOT, f))}`);
}
