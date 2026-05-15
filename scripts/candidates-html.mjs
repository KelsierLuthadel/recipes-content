#!/usr/bin/env node
// Generate a single-page HTML viewer of every staged Pexels candidate,
// so you can scan all the options at once and pick winners. The current
// hero image is shown alongside the candidates for direct comparison.
//
// Output: candidates.html in the repo root (gitignored). Open it in a
// browser; click any thumbnail to view full-size. Captions are plain
// text in the form "Recipe Title - relative/path/to/image.jpg".

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, posix, sep, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md']);
const OUT = join(REPO_ROOT, 'candidates.html');

function toPosix(p) { return p.split(sep).join(posix.sep); }
function relPath(p) { return toPosix(relative(REPO_ROOT, p)); }

// Build a URL safe for href / src attributes inside the HTML, where the
// HTML lives at the repo root and paths are relative to it.
function urlPath(p) {
  return relPath(p).split('/').map(encodeURIComponent).join('/');
}

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function renderHtml(sections) {
  const css = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 1.25rem; background: #f5f5f5; color: #1f2937; }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #e5e7eb; }
      .section { background: #1c1c1c; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
      .section .dir, .item .caption { color: #9ca3af; }
      .item .label { background: #374151; color: #e5e7eb; }
      .item.current .label { background: #78350f; color: #fde68a; }
    }
    h1 { margin: 0 0 0.5rem; font-weight: 600; }
    .summary { color: #6b7280; margin: 0 0 1.5rem; font-size: 0.9rem; }
    .section { background: #fff; padding: 1rem 1rem 1.25rem; margin-bottom: 1rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .section h2 { margin: 0; font-size: 1.05rem; font-weight: 600; }
    .section .dir { font-size: 0.82rem; margin: 0.2rem 0 0.85rem; }
    .row { display: flex; gap: 0.85rem; flex-wrap: wrap; }
    .item { flex: 0 0 280px; min-width: 0; }
    .item .label { display: inline-block; padding: 1px 8px; font-size: 0.72rem; background: #e5e7eb; color: #374151; border-radius: 999px; margin-bottom: 0.3rem; font-weight: 500; }
    .item.current .label { background: #fef3c7; color: #92400e; }
    .item .img-wrap { display: block; aspect-ratio: 4/3; background: #ddd; border-radius: 4px; overflow: hidden; }
    .item img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
    .item.current .img-wrap { outline: 3px solid #f59e0b; outline-offset: -3px; }
    .item .caption { font-size: 0.76rem; color: #555; margin-top: 0.35rem; line-height: 1.35; word-wrap: break-word; }
  `;

  const sectionHtml = sections.map(s => {
    const dirRel = relPath(s.candidatesDir);

    const items = [];
    if (s.currentImage) {
      items.push({
        label: 'Current',
        href: urlPath(s.currentImage),
        captionPath: relPath(s.currentImage),
        current: true,
      });
    }
    for (const c of s.candidates) {
      items.push({
        label: c.label,
        href: urlPath(c.path),
        captionPath: relPath(c.path),
        current: false,
      });
    }

    const itemsHtml = items.map(it => `
      <div class="item${it.current ? ' current' : ''}">
        <span class="label">${escapeHtml(it.label)}</span>
        <a class="img-wrap" href="${it.href}" target="_blank" rel="noopener"><img src="${it.href}" alt="${escapeHtml(s.title)} - ${escapeHtml(it.label)}" loading="lazy"></a>
        <div class="caption">${escapeHtml(s.title)} - ${escapeHtml(it.captionPath)}</div>
      </div>
    `).join('');

    return `
      <section class="section">
        <h2>${escapeHtml(s.title)}</h2>
        <div class="dir">${escapeHtml(dirRel)}/</div>
        <div class="row">${itemsHtml}</div>
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Image candidates (${sections.length})</title>
<style>${css}</style>
</head>
<body>
<h1>Image candidates</h1>
<p class="summary">${sections.length} recipe section${sections.length === 1 ? '' : 's'}. Click a thumbnail to open full size.</p>
${sectionHtml}
</body>
</html>
`;
}

function main() {
  const sections = [];
  for (const file of walk(REPO_ROOT)) {
    const md = readFileSync(file, 'utf8');
    const title = extractTitle(md);
    if (!title) continue;
    const imagePath = extractFirstImage(md);
    if (!imagePath || /^https?:/i.test(imagePath)) continue;
    const onDisk = join(dirname(file), ...imagePath.split('/'));
    const ext = extname(onDisk);
    const stem = basename(onDisk, ext);
    const candidatesDir = join(dirname(onDisk), 'candidates', stem);
    if (!existsSync(candidatesDir)) continue;

    const candidates = readdirSync(candidatesDir)
      .filter(n => n.startsWith(`${stem}-`))
      .sort()
      .map(n => {
        const m = n.match(/-(\d+)\./);
        return { path: join(candidatesDir, n), label: m ? m[1] : n };
      });
    if (!candidates.length) continue;

    sections.push({
      title,
      candidatesDir,
      candidates,
      currentImage: existsSync(onDisk) ? onDisk : null,
    });
  }

  if (!sections.length) {
    console.log('No candidate folders found. Run scripts/fetch-candidates.mjs first.');
    return;
  }

  sections.sort((a, b) => a.title.localeCompare(b.title));
  writeFileSync(OUT, renderHtml(sections), 'utf8');
  console.log(`Wrote ${relPath(OUT)} with ${sections.length} recipe section${sections.length === 1 ? '' : 's'}.`);
  console.log(`Open it in a browser:  file:///${toPosix(OUT)}`);
}

main();
