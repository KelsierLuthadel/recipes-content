// Emit a compact JSON of every Overview that triggers any of the
// audit-overview-prose patterns. Used as input for batched rewrites.
//
// Output: [{ file, title, overview }] sorted by file path.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);

const PATTERNS = [
  /(?:^|(?<=[.!?]\s))(Cooled|Drained|Mixed|Folded|Sliced|Diced|Chopped|Refrigerated|Chilled|Rested|Baked|Boiled|Simmered|Poached|Fried|Sautéed|Roasted|Toasted|Grilled|Steamed|Whisked|Blended|Stirred|Tossed|Seasoned|Salted|Sweetened|Reduced|Strained|Pulsed|Kneaded|Shaped|Rolled|Stuffed|Wrapped|Sealed|Cut|Tipped|Inverted|Plated|Served|Eaten|Beaten|Brushed|Spread|Crumbled|Mashed|Glazed|Sprinkled|Scattered|Dusted)\b(?:[^.!?]*?)\./,
  /\b(NEVER|NOT|ALWAYS|MUST|DON'T|DO|ONLY|JUST|EXACTLY|KEY|CRITICAL|ESSENTIAL|REQUIRED|MANDATORY|NEEDS?)\b/,
  /-/,
  / - /,
  /\b(?:is|are)\s+the\s+(?:trick|key|point|secret|whole point|signature|defining|crucial bit|hard part)\b/i,
  /(?:^|(?<=[.!?]\s))[A-Z][a-z]+(?:\s[a-z]+){0,2}\./,
];

async function walk(dir, isRoot = false) {
  const out = [];
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name === 'resources') continue;
      out.push(...await walk(full));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      if (isRoot && /^(readme|license|changelog)\.md$/i.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

function extractTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractOverviewText(md) {
  const m = md.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
  if (!m) return null;
  return m[1].trim();
}

const files = await walk(ROOT, true);
const out = [];
for (const f of files) {
  const md = await readFile(f, 'utf8');
  const overview = extractOverviewText(md);
  if (!overview) continue;
  if (!PATTERNS.some(p => p.test(overview))) continue;
  out.push({
    file: path.relative(ROOT, f).replace(/\\/g, '/'),
    title: extractTitle(md),
    overview,
  });
}
out.sort((a, b) => a.file.localeCompare(b.file));
console.error(`Flagged: ${out.length} of ${files.length}`);
process.stdout.write(JSON.stringify(out, null, 2));
