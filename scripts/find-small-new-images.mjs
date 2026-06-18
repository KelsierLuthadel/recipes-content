#!/usr/bin/env node
// Intersect: images under <threshold>px wide AND newly-added (git status).
// Output: list of paths that probably need a higher-resolution replacement.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const THRESHOLD = parseInt(process.argv[2] || '800', 10);

function toPosix(p) { return p.split(sep).join(posix.sep); }

function jpegSize(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1];
    i += 2;
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      return { width: (buf[i + 5] << 8) | buf[i + 6], height: (buf[i + 3] << 8) | buf[i + 4] };
    }
    if (marker === 0xD8 || marker === 0xD9) return null;
    const segLen = (buf[i] << 8) | buf[i + 1];
    i += segLen;
  }
  return null;
}

// "New" = staged for add OR untracked. Covers both before-commit states.
const newImages = new Set();
const untracked = execSync('git ls-files --others --exclude-standard', { cwd: REPO_ROOT }).toString().split('\n');
const stagedNew = execSync('git diff --cached --name-only --diff-filter=A', { cwd: REPO_ROOT }).toString().split('\n');
for (const line of [...untracked, ...stagedNew]) {
  const t = line.trim();
  if (/\.(jpe?g|png)$/i.test(t)) newImages.add(t);
}

console.log(`# Newly-added images: ${newImages.size}`);
console.log(`# Threshold: width < ${THRESHOLD}px`);
console.log();

const small = [];
for (const rel of newImages) {
  const full = join(REPO_ROOT, rel);
  try {
    const buf = readFileSync(full);
    const dim = jpegSize(buf);
    if (!dim) continue;
    if (dim.width < THRESHOLD) small.push({ path: toPosix(rel), w: dim.width, h: dim.height, kb: Math.round(buf.length / 1024) });
  } catch {}
}
small.sort((a, b) => a.w - b.w);

console.log(`# Small (under ${THRESHOLD}px): ${small.length}`);
for (const s of small) console.log(`  ${String(s.w).padStart(5)}x${String(s.h).padStart(5)}  ${String(s.kb).padStart(5)}KB  ${s.path}`);
