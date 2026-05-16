// Broader Overview-voice audit. Flags patterns that make Overviews read
// like a recipe author's shorthand notes rather than descriptive prose:
//
//   1. Subjectless past-participle sentences ("Cooled.", "Mixed with X.",
//      "Drained.") - typically sentence-internal short fragments where
//      the implicit subject is "the pork", "the dough", etc.
//   2. ALL-CAPS words mid-sentence used for emphasis (NEVER, NOT, MUST).
//   3. Em-dashes (U+2014) - per project style: prefer comma or paren.
//   4. Hyphen-with-spaces used as a dash ( - ) - same intent, dashier feel.
//   5. "X is the trick / key / point" - casual assertion.
//   6. Short telegraphic 1-3 word sentences (e.g. "Plate.", "Done.").

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);

const PATTERNS = [
  {
    id: 'subjectless-pastp',
    label: 'Subjectless past-participle sentence',
    // A sentence that begins (after . or paragraph start) with a -ed verb
    // and no preceding noun phrase as subject. We restrict to a known set
    // of recipe verbs to limit false positives.
    re: /(?:^|(?<=[.!?]\s))(Cooled|Drained|Mixed|Folded|Sliced|Diced|Chopped|Refrigerated|Chilled|Rested|Cooled|Baked|Boiled|Simmered|Poached|Fried|Sautéed|Roasted|Toasted|Grilled|Steamed|Whisked|Blended|Stirred|Tossed|Seasoned|Salted|Sweetened|Reduced|Strained|Pulsed|Kneaded|Shaped|Rolled|Stuffed|Wrapped|Sealed|Cut|Tipped|Inverted|Plated|Served|Eaten|Beaten|Brushed|Spread|Crumbled|Mashed|Glazed|Sprinkled|Scattered|Dusted)\b(?:[^.!?]*?)\./g,
  },
  {
    id: 'caps-emphasis',
    label: 'ALL-CAPS emphasis word',
    re: /\b(NEVER|NOT|ALWAYS|MUST|DON'T|DO|MUST|ONLY|JUST|EXACTLY|KEY|CRITICAL|ESSENTIAL|REQUIRED|MANDATORY|NEEDS?)\b/g,
  },
  {
    id: 'em-dash',
    label: 'Unicode em-dash (U+2014)',
    re: /—/g,
  },
  {
    id: 'spaced-dash',
    label: 'Spaced hyphen used as dash ( - )',
    re: / - /g,
  },
  {
    id: 'casual-trick',
    label: '"X is the trick/key/point" casual assertion',
    re: /\b(?:is|are)\s+the\s+(?:trick|key|point|secret|whole point|signature|defining|crucial bit|hard part)\b/gi,
  },
  {
    id: 'telegraphic-fragment',
    label: 'Telegraphic 1-3-word sentence',
    // A sentence comprising 1-3 short words ending in a period.
    // Anchored to sentence boundary: after period or paragraph start.
    re: /(?:^|(?<=[.!?]\s))[A-Z][a-z]+(?:\s[a-z]+){0,2}\./g,
  },
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

function extractOverviewText(md) {
  const m = md.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
  if (!m) return null;
  return m[1].trim();
}

const files = await walk(ROOT, true);
const tally = Object.fromEntries(PATTERNS.map(p => [p.id, { label: p.label, files: 0, hits: 0, samples: [] }]));
const fileHits = new Map(); // file -> Set of pattern ids

for (const f of files) {
  const md = await readFile(f, 'utf8');
  const overview = extractOverviewText(md);
  if (!overview) continue;
  for (const p of PATTERNS) {
    const matches = [...overview.matchAll(p.re)];
    if (matches.length === 0) continue;
    tally[p.id].hits += matches.length;
    if (!fileHits.has(f)) fileHits.set(f, new Set());
    if (!fileHits.get(f).has(p.id)) {
      tally[p.id].files++;
      fileHits.get(f).add(p.id);
    }
    if (tally[p.id].samples.length < 6) {
      tally[p.id].samples.push({
        file: path.relative(ROOT, f).replace(/\\/g, '/'),
        match: matches[0][0].trim().slice(0, 110),
      });
    }
  }
}

const overallFiles = fileHits.size;
console.log(`Scanned ${files.length} recipes; ${overallFiles} have at least one flagged pattern.\n`);
for (const id of Object.keys(tally)) {
  const t = tally[id];
  console.log(`[${id}] ${t.label}`);
  console.log(`  files affected: ${t.files}`);
  console.log(`  total hits:     ${t.hits}`);
  for (const s of t.samples) {
    console.log(`    ${s.file}:`);
    console.log(`      "${s.match}"`);
  }
  console.log('');
}
