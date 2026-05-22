// Scan every recipe's Overview section for the missing-preposition
// pattern: "<verb> <number> <time-unit>" where professional voice wants
// "<verb> FOR <number> <time-unit>".
//
//   bad:  "soaked 1 hour"      "par-boiled 5 minutes"      "rest 30 minutes"
//   good: "soaked for 1 hour"  "par-boiled for 5 minutes"  "rest for 30 minutes"
//
// Output: JSON array of { file, hits: [{ match, suggestion }] }.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP = new Set(['scripts', 'documentation', 'resources', 'editorial', 'node_modules', '.git']);

// The verb forms we care about. Past tense / present / imperative all
// suffer from the missing-"for" issue equally.
const TIMING_VERBS = [
  // soaking / steeping
  'soak(?:ed|s)?', 'steep(?:ed|s)?', 'macerate[ds]?', 'marinate[ds]?',
  // boiling / simmering
  'boil(?:ed|s)?', 'par-boil(?:ed|s)?', 'parboil(?:ed|s)?',
  'simmer(?:ed|s)?', 'poach(?:ed|es)?',
  // baking / roasting
  'bak(?:e[sd]?|ing)', 'roast(?:ed|s)?', 'grill(?:ed|s)?', 'broil(?:ed|s)?',
  'toast(?:ed|s)?', 'crisp(?:ed|s)?',
  // frying
  'fr(?:y|ies|ied)', 'sauté(?:e[ds]?|s)?', 'sear(?:ed|s)?',
  'pan-fr(?:y|ies|ied)', 'stir-fr(?:y|ies|ied)', 'deep-fr(?:y|ies|ied)',
  // steaming
  'steam(?:ed|s)?',
  // resting / cooling / chilling / proving
  'rest(?:ed|s)?', 'cool(?:ed|s)?', 'chill(?:ed|s)?', 'refrigerat(?:e[ds]?|ing)',
  'prove[ds]?', 'proof(?:ed|s)?', 'ris(?:e[sn]?|ing|en)',
  // misc
  'cook(?:ed|s)?', 'reduc(?:e[ds]?|ing)', 'braise[ds]?', 'stew(?:ed|s)?',
  'whisk(?:ed|s)?', 'beat(?:s|en)?', 'churn(?:ed|s)?', 'whip(?:ped|s)?',
  'set(?:s)?', 'soften(?:ed|s)?', 'wilt(?:ed|s)?',
];

// Time units: minute(s), hour(s), second(s), and their abbreviations.
const TIME_UNITS = String.raw`(?:minute|hour|second|min|hr|sec|h)s?`;

// The pattern.
//  - \b<verb>\b
//  - whitespace
//  - number: digits, optional fractional/range parts like "1 ½", "5-7", "12-15"
//  - whitespace (or hyphen for "30-minute")
//  - time unit
//  - NOT immediately preceded by "for " (use a non-capturing negative lookbehind via the construction)
//
// Number group permits:
//   \d+ optionally followed by " ½", "-\d+", " 1/2" etc.
function buildPattern() {
  const verbs = TIMING_VERBS.join('|');
  // Number: 1-3 digits, then optional "-digits" range or " ½" fraction.
  const num = String.raw`\d{1,3}(?:\s*[--]\s*\d{1,3}|\s*[½⅓¼¾⅔])?`;
  // Word boundary, verb, space, number, optional space-or-hyphen, time unit.
  // Captures the whole offending phrase.
  return new RegExp(
    String.raw`\b(${verbs})\s+(${num})\s*[ -]\s*(${TIME_UNITS})\b`,
    'gi',
  );
}

const PATTERN = buildPattern();

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

// Some matches are false positives: e.g. "30-minute rest" is fine because
// "30-minute" is an adjective. Reject when the time-unit-side is hyphen-
// glued to the number to form a compound modifier ("30-minute pastry").
function isFalsePositive(match, fullText, startIndex) {
  // If the original text uses "30-minute" (hyphen + word), it's adjectival.
  // Our regex already requires a space-or-hyphen between number and unit;
  // hyphen + word AFTER unit (e.g. "5-minute rest") is the compound case.
  // Look forward in text after the match for a following lowercase word.
  const after = fullText.slice(startIndex + match.length, startIndex + match.length + 1);
  // If immediately followed by ' rest' / ' simmer' / etc., the matched
  // phrase is part of a noun-phrase modifier, not a duration clause.
  // Cheap-and-cheerful: require the next char to be sentence-ending or
  // a non-letter to count as a real duration.
  if (after && /[a-zA-Z-]/.test(after)) return true;
  // Also reject the pre-existing "for X minutes" form by checking the
  // word immediately BEFORE the match.
  const before = fullText.slice(Math.max(0, startIndex - 5), startIndex).toLowerCase();
  if (/\bfor\s$/.test(before)) return true;
  return false;
}

const files = await walk(ROOT, true);
const hits = [];
for (const f of files) {
  const md = await readFile(f, 'utf8');
  const overview = extractOverviewText(md);
  if (!overview) continue;
  const phrases = [];
  for (const m of overview.matchAll(PATTERN)) {
    if (isFalsePositive(m[0], overview, m.index)) continue;
    // Suggestion: insert "for " between the verb and the number.
    const suggestion = m[0].replace(/(\S+)(\s+)(\d)/, '$1$2for $3');
    phrases.push({ match: m[0], suggestion });
  }
  if (phrases.length === 0) continue;
  hits.push({
    file: path.relative(ROOT, f).replace(/\\/g, '/'),
    hits: phrases,
  });
}

console.error(`Scanned ${files.length} recipes.`);
console.error(`Files with at least one missing-"for": ${hits.length}`);
let total = 0; for (const h of hits) total += h.hits.length;
console.error(`Total flagged phrases: ${total}`);
process.stdout.write(JSON.stringify(hits, null, 2));
