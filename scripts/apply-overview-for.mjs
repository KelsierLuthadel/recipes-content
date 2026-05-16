// Apply the "insert FOR before duration" fix produced by
// audit-overview-for.mjs. Input is the audit's JSON output:
//   [{ file, hits: [{ match, suggestion }] }]
//
// For each file, opens the Overview section only and replaces each
// `match` with `suggestion` exactly once. Other sections are untouched
// so we don't accidentally inflate ingredient-list or method timings
// that may already read fine.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function replaceInOverview(md, match, suggestion) {
  // Find the Overview section bounds.
  const re = /(^##\s+Overview\s*\r?\n)([\s\S]*?)(?=^##\s|$(?![\r\n]))/m;
  const m = md.match(re);
  if (!m) return { md, changed: false };
  const head = md.slice(0, m.index + m[1].length);
  let body = m[2];
  const tail = md.slice(m.index + m[1].length + body.length);
  // Replace ONCE inside the body.
  const before = body;
  body = body.replace(match, suggestion);
  if (body === before) return { md, changed: false };
  return { md: head + body + tail, changed: true };
}

async function main() {
  const batchPath = process.argv[2];
  if (!batchPath) {
    console.error('Usage: node scripts/apply-overview-for.mjs path/to/audit.json');
    process.exit(2);
  }
  // The audit prints summary lines to stderr but JSON to stdout. If the
  // caller saved combined output via `> file`, strip the leading
  // non-JSON lines defensively.
  const raw = await readFile(batchPath, 'utf8');
  const start = raw.indexOf('[');
  const entries = JSON.parse(raw.slice(start));
  let totalApplied = 0;
  let totalSkipped = 0;
  for (const entry of entries) {
    const abs = path.join(ROOT, entry.file);
    let md;
    try { md = await readFile(abs, 'utf8'); }
    catch (e) { console.log(`SKIPPED (read fail): ${entry.file}`); totalSkipped += entry.hits.length; continue; }
    let applied = 0;
    for (const { match, suggestion } of entry.hits) {
      const r = replaceInOverview(md, match, suggestion);
      if (r.changed) { md = r.md; applied++; }
      else { totalSkipped++; console.log(`SKIPPED (no match): ${entry.file} :: "${match}"`); }
    }
    if (applied > 0) await writeFile(abs, md, 'utf8');
    totalApplied += applied;
  }
  console.log(`Applied ${totalApplied} fixes across ${entries.length} files; skipped ${totalSkipped}.`);
  if (totalSkipped > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
