// Apply a batch of byline rewrites described in a JSON file. The input
// is an array of { file, new_byline } objects where:
//   - file is a path relative to the recipes-content root
//   - new_byline is the replacement text (NO asterisks - the script
//     wraps it). Plain text, single line, no trailing period required.
//
// For each entry, the script locates the existing italic byline (a
// paragraph wholly wrapped in `*...*` within the first 15 non-empty
// content lines) and replaces JUST that line. Other content is
// untouched.
//
// If a file already has no italic byline, the script INSERTS the new
// one immediately after the H1's image paragraph (or after the H1 if
// there's no image), with a blank line on either side. This handles
// the missing-byline tail of the rewrite project.
//
// Usage:
//   node scripts/apply-byline-rewrites.mjs path/to/batch.json
//
// Output: prints a one-line summary per file (REPLACED / INSERTED /
// SKIPPED) and a final count. Exits non-zero if any entry failed so a
// supervising script can stop the project.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function findBylineLine(lines) {
  // Mirror the audit's detection: the italic byline is the first
  // paragraph wholly wrapped in `*...*` within the first 15 non-empty
  // content lines after the H1 / image. Return the line index, or -1
  // if none found.
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 15; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    seen++;
    if (/^#\s/.test(t)) continue;
    if (/^!\[/.test(t)) continue;
    if (/^\*\*[A-Za-z][^*]*:\*\*/.test(t)) return -1;
    if (/^##\s/.test(t)) return -1;
    if (/^\*[^*].*[^*]\*$/.test(t) || /^\*[^*]+\*$/.test(t)) return i;
    return -1;
  }
  return -1;
}

function findInsertionPoint(lines) {
  // Insert the byline after the image paragraph that follows the H1,
  // or directly after the H1 if no image. Returns the line index BEFORE
  // which the new byline + surrounding blank lines should be inserted.
  // (i.e. content from this index onwards gets pushed down.)
  let h1Idx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (/^#\s/.test(lines[i].trim())) { h1Idx = i; break; }
  }
  if (h1Idx < 0) return -1;
  // Look for an image paragraph within 4 lines after the H1.
  for (let i = h1Idx + 1; i < Math.min(lines.length, h1Idx + 6); i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^!\[/.test(t)) return i + 1;
    // First non-image, non-blank line after H1 means there's no image;
    // insert right after the H1.
    return h1Idx + 1;
  }
  return h1Idx + 1;
}

async function processEntry(entry) {
  const { file, new_byline } = entry;
  if (!file || !new_byline) return { file, status: 'SKIPPED (bad entry)' };
  const abs = path.join(ROOT, file);
  let md;
  try { md = await readFile(abs, 'utf8'); }
  catch (e) { return { file, status: `SKIPPED (read failed: ${e.code || e.message})` }; }
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const newLine = `*${new_byline.trim()}*`;
  const idx = findBylineLine(lines);
  let status;
  if (idx >= 0) {
    lines[idx] = newLine;
    status = 'REPLACED';
  } else {
    const insertAt = findInsertionPoint(lines);
    if (insertAt < 0) return { file, status: 'SKIPPED (no H1 found)' };
    // Insert with blank lines on both sides to match the existing
    // recipe shape (image / blank / byline / blank / frontmatter).
    // If the line right above or below is already blank, don't add a
    // second blank.
    const beforeBlank = insertAt > 0 && lines[insertAt - 1].trim() === '' ? '' : null;
    const afterBlank = lines[insertAt] && lines[insertAt].trim() === '' ? '' : null;
    const toInsert = [];
    if (beforeBlank === null) toInsert.push('');
    toInsert.push(newLine);
    if (afterBlank === null) toInsert.push('');
    lines.splice(insertAt, 0, ...toInsert);
    status = 'INSERTED';
  }
  await writeFile(abs, lines.join(eol), 'utf8');
  return { file, status };
}

async function main() {
  const batchPath = process.argv[2];
  if (!batchPath) {
    console.error('Usage: node scripts/apply-byline-rewrites.mjs path/to/batch.json');
    process.exit(2);
  }
  const raw = await readFile(batchPath, 'utf8');
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    console.error('Batch file must be a JSON array.');
    process.exit(2);
  }
  let replaced = 0, inserted = 0, skipped = 0;
  for (const entry of entries) {
    const r = await processEntry(entry);
    if (r.status === 'REPLACED') replaced++;
    else if (r.status === 'INSERTED') inserted++;
    else skipped++;
    if (r.status.startsWith('SKIPPED')) console.log(`${r.status}: ${r.file}`);
  }
  console.log(`Applied ${entries.length}: replaced=${replaced}, inserted=${inserted}, skipped=${skipped}.`);
  if (skipped > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
