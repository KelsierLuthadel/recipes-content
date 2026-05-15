// Cleanup pass: replace em dashes with hyphens. The site rule is no em
// dashes anywhere - in recipes, in JSON data files, or in code comments.
// The mechanical substitution (" - " for spaced em, "-" otherwise) keeps
// the visual break and doesn't reflow any sentences. Awkward results can
// be hand-fixed afterwards.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

// Folders we walk recursively for .md, .json, .js, .css files.
const ROOTS = [
  'appetizer', 'baking', 'base-ingredients', 'bread-pasta', 'breakfast',
  'coulis', 'cuisine', 'desert', 'petit-four', 'pies', 'rice', 'salad',
  'salsa', 'sauces', 'sides', 'snacks', 'soup', 'sponge', 'starter',
  'stocks', 'tarts', 'vinaigrette',
  'docs', 'scripts', 'documentation',
];

// Standalone files at the repo root that aren't inside a walked folder.
const ROOT_FILES = [
  'CHANGELOG.md', 'README.md',
  'categories.json', 'wine-pairings.json', 'side-pairings.json',
  'substitutions.json',
  'worker.js', 'wrangler.jsonc',
];

// Skip the auto-generated manifest - the next `npm run build` rewrites it
// clean from the source markdown. Skip vendor JS we don't own.
const SKIP_PATHS = new Set([
  'docs/recipes.json',
  'docs/recipes.json'.replaceAll('/', '\\'),
]);
function isSkippedDir(dir) {
  return dir === 'docs/vendor' || dir.endsWith('/vendor') || dir.endsWith('\\vendor')
    || dir.endsWith('/resources') || dir.endsWith('\\resources')
    || dir === 'docs/css' && false; // keep docs/css; this is just a placeholder
}

const EXTENSIONS = new Set(['.md', '.json', '.js', '.css', '.mjs']);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'resources' || entry.name === 'node_modules' || entry.name === '.git') continue;
      yield* walk(path);
    } else {
      if (SKIP_PATHS.has(path) || SKIP_PATHS.has(path.replaceAll('\\', '/'))) continue;
      const ext = '.' + (entry.name.split('.').pop() || '').toLowerCase();
      if (EXTENSIONS.has(ext)) yield path;
    }
  }
}

// Match em-dash (U+2014) and en-dash (U+2013). Both are out - the site
// uses plain ASCII hyphen-minus everywhere. The character class is built
// at runtime from codepoints because writing the literal en/em dashes
// inline gets silently autocorrected back to ASCII hyphens by most
// editors (and by this script's own previous runs).
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const FANCY_DASH = new RegExp(`[${EN_DASH}${EM_DASH}]`, 'g');
const FANCY_DASH_SPACED = new RegExp(` [${EN_DASH}${EM_DASH}] `, 'g');

async function processFile(path) {
  const text = await readFile(path, 'utf8');
  if (!FANCY_DASH.test(text)) return 0;
  FANCY_DASH.lastIndex = 0;
  const count = (text.match(FANCY_DASH) || []).length;
  const updated = text
    .replace(FANCY_DASH_SPACED, ' - ')
    .replace(FANCY_DASH, '-');
  await writeFile(path, updated);
  console.log(`${path}: ${count}`);
  return count;
}

let totalDashes = 0;
let fileCount = 0;

for (const root of ROOTS) {
  for await (const path of walk(root)) {
    const dashes = await processFile(path);
    if (dashes > 0) { totalDashes += dashes; fileCount += 1; }
  }
}

for (const file of ROOT_FILES) {
  try {
    const dashes = await processFile(file);
    if (dashes > 0) { totalDashes += dashes; fileCount += 1; }
  } catch { /* file missing - skip */ }
}

console.log(`\nReplaced ${totalDashes} em dash${totalDashes === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}.`);
