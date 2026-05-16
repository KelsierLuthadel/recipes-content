// Tighter audit: TRUE subjectless past-participle fragments only.
//
// A sentence is flagged when:
//   - it begins with a past-participle verb (Steamed, Drained, Plated, etc.)
//   - the sentence contains NO clear comma-followed-by-subject pattern (so
//     it isn't a participial phrase like "Sealed with X, the parcels are...")
//   - the sentence is reasonably short (under 60 chars) OR is followed by
//     a period without ever introducing a noun-subject.
//
// Output: JSON of { file, fragments: [string] }.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);

const PASTP_VERBS = [
  'Cooled', 'Drained', 'Mixed', 'Folded', 'Sliced', 'Diced', 'Chopped',
  'Refrigerated', 'Chilled', 'Rested', 'Baked', 'Boiled', 'Simmered',
  'Poached', 'Fried', 'Sautéed', 'Roasted', 'Toasted', 'Grilled', 'Steamed',
  'Whisked', 'Blended', 'Stirred', 'Tossed', 'Seasoned', 'Salted',
  'Sweetened', 'Reduced', 'Strained', 'Pulsed', 'Kneaded', 'Shaped',
  'Rolled', 'Stuffed', 'Wrapped', 'Sealed', 'Cut', 'Tipped', 'Inverted',
  'Plated', 'Served', 'Eaten', 'Beaten', 'Brushed', 'Spread', 'Crumbled',
  'Mashed', 'Glazed', 'Sprinkled', 'Scattered', 'Dusted', 'Pan-fried',
  'Stuffed', 'Stretched', 'Pressed', 'Pulled',
];

// Words that look like the start of a noun-subject (most common ones that
// appear after a comma in a participial-phrase Overview).
const SUBJECT_HEAD = /(?:the|a|an|this|that|each|every|both|some|its|their|our|my|her|his)\s+/i;

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

function splitSentences(text) {
  // Naive: split on `. ` followed by a capital letter. Good enough.
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/);
}

function isTrueFragment(sentence) {
  const trimmed = sentence.trim();
  // Must start with one of our past-participle verbs (whole word).
  let leading = null;
  for (const v of PASTP_VERBS) {
    const re = new RegExp(`^${v}\\b`);
    if (re.test(trimmed)) { leading = v; break; }
  }
  if (!leading) return false;
  // If the sentence (after the verb) introduces a subject via ", THE/A/etc + verb",
  // it's a participial phrase, not a fragment. Look for ", " followed by a
  // subject head somewhere in the sentence.
  // Strip the leading verb first to avoid matching it as the subject.
  const after = trimmed.slice(leading.length);
  if (/,\s*(?:the|a|an|this|that|each|every|both|some|its|their|our|my|her|his)\s+\w+/i.test(after)) {
    return false;
  }
  // If the sentence is a noun phrase ("Mixed spice (also called...)"), the
  // past-participle is actually an adjective. Heuristic: if the leading word
  // is followed by a lowercase noun (common-noun pattern), reject.
  // E.g. "Mixed spice", "Mashed potato", "Boiled eggs". We test: leading verb
  // + space + lowercase word.
  if (/^[a-z]/.test(after.replace(/^\s+/, '').replace(/^[(]/, ''))) {
    // "Mixed spice (also called..." -> after = " spice (also called..."
    // First non-space character is lowercase -> noun phrase / adjective use.
    return false;
  }
  return true;
}

const files = await walk(ROOT, true);
const hits = [];
for (const f of files) {
  const md = await readFile(f, 'utf8');
  const overview = extractOverviewText(md);
  if (!overview) continue;
  const fragments = [];
  for (const s of splitSentences(overview)) {
    if (isTrueFragment(s)) fragments.push(s.trim());
  }
  if (fragments.length === 0) continue;
  hits.push({
    file: path.relative(ROOT, f).replace(/\\/g, '/'),
    fragments,
  });
}
let total = 0; for (const h of hits) total += h.fragments.length;
console.error(`Files with TRUE subjectless fragments: ${hits.length}`);
console.error(`Total fragments: ${total}`);
process.stdout.write(JSON.stringify(hits, null, 2));
