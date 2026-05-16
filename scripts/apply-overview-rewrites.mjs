// Apply a batch of Overview-section rewrites described in a JSON file.
// Input: [{ file, new_overview }] where file is relative to recipes-content
// root and new_overview is the replacement prose (no '## Overview' header
// - the script preserves the heading and just swaps the body).
//
// Usage:
//   node scripts/apply-overview-rewrites.mjs path/to/batch.json
//
// Output: a one-line REPLACED / SKIPPED per file plus a final count.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

async function processEntry({ file, new_overview }) {
  if (!file || !new_overview) return { file, status: 'SKIPPED (bad entry)' };
  const abs = path.join(ROOT, file);
  let md;
  try { md = await readFile(abs, 'utf8'); }
  catch (e) { return { file, status: `SKIPPED (read failed: ${e.code || e.message})` }; }
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  // Match the Overview heading + body up to the next ##-or-end-of-file.
  // ([\s\S]*?) is the body; the lookahead is the next h2 (or document end).
  const re = /(^##\s+Overview\s*\r?\n)([\s\S]*?)(?=^##\s|$(?![\r\n]))/m;
  if (!re.test(md)) return { file, status: 'SKIPPED (no Overview section)' };
  const replaced = md.replace(re, (_full, heading) => {
    const body = new_overview.trim().replace(/\r?\n/g, eol);
    // Trailing blank line so the next ## still has breathing room.
    return `${heading}${body}${eol}${eol}`;
  });
  await writeFile(abs, replaced, 'utf8');
  return { file, status: 'REPLACED' };
}

async function main() {
  const batchPath = process.argv[2];
  if (!batchPath) {
    console.error('Usage: node scripts/apply-overview-rewrites.mjs path/to/batch.json');
    process.exit(2);
  }
  const entries = JSON.parse(await readFile(batchPath, 'utf8'));
  if (!Array.isArray(entries)) {
    console.error('Batch file must be a JSON array.');
    process.exit(2);
  }
  let replaced = 0, skipped = 0;
  for (const entry of entries) {
    const r = await processEntry(entry);
    if (r.status === 'REPLACED') replaced++;
    else { skipped++; console.log(`${r.status}: ${r.file}`); }
  }
  console.log(`Applied ${entries.length}: replaced=${replaced}, skipped=${skipped}.`);
  if (skipped > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
