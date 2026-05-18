// Clean up ingredient bullet lines with two rules:
//
//   1. Strip a leading "About" / "Additional" / "Approximately":
//      "About 1 Litre Sunflower Oil"      -> "1 Litre Sunflower Oil"
//      "Additional 2 Tablespoons Oil"     -> "2 Tablespoons Oil"
//      "Approximately 4 cloves of garlic" -> "4 cloves of garlic"
//
//   2. Move a leading size word (small/medium/large, with optional
//      "sized" / "-sized" / "size" suffix) into a trailing parenthesis:
//      "small carrot"                 -> "carrot (small)"
//      "1 large onion"                -> "1 onion (large)"
//      "medium sized lettuce"         -> "lettuce (medium sized)"
//      "1 large onion (sliced)"       -> "1 onion (large, sliced)"
//   Skipped when the word after the size is a unit/container
//   ("small bunch coriander", "large pinch salt", "1 small stick
//   cinnamon" all stay put).
//
// Operates only on bullets inside the `## Ingredients` block;
// sub-headings like `### Equipment` are skipped.
//
// Modes:
//   node clean-ingredient-lines.mjs --dry-run    (default)
//   node clean-ingredient-lines.mjs --apply

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Strip "about" / "additional" / "approximately" - either at the very
// start of the bullet ("Additional 2 tablespoons oil"), right after a
// leading number ("3 additional large egg yolks"), or right after a
// number-and-unit pair ("200 ml additional coconut milk"). Group 1
// captures the optional qty prefix so it's preserved; group 2 is the
// word to drop.
const LEADING_WORD_RE = /^((?:\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?(?:\s+\d+\/\d+)?\s+(?:[a-z]+\.?\s+)?)?)(about|additional|approximately)\s+/i;

// Quantity prefix that may sit before the size word. Either an article
// ("a"/"an") or a leading number. We deliberately don't try to eat a
// unit word here, because units like "tablespoon" and size words like
// "medium" look identical to the regex and the size word must NOT get
// consumed - the size rule needs to see it.
const QTY_PREFIX_RE = /^((?:a|an)\s+|\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?(?:\s+\d+\/\d+)?\s+)?/i;

// Size word + optional "sized" / "-sized" / "size" suffix.
const SIZE_RE = /^(small|medium|large)((?:[- ](?:sized?|size))?)\s+/i;

// Words that, when they follow the size, mean the size belongs to the
// unit / container rather than the ingredient itself.
const NON_INGREDIENT_AFTER_SIZE = new Set([
  'bunch', 'bunches', 'pinch', 'pinches', 'handful', 'handfuls',
  'knob', 'knobs', 'dash', 'dashes', 'splash', 'splashes',
  'sprig', 'sprigs', 'piece', 'pieces', 'stick', 'sticks',
  'clove', 'cloves', 'slice', 'slices', 'glass', 'glasses',
  'spoonful', 'spoonfuls', 'can', 'cans', 'tin', 'tins',
  'jar', 'jars', 'bottle', 'bottles', 'packet', 'packets',
  'sachet', 'sachets', 'bowl', 'bowls', 'cup', 'cups',
  'pot', 'pots', 'head', 'heads', 'thumb', 'thumbs',
  'bag', 'bags', 'cube', 'cubes', 'dice', 'drop', 'drops',
  'squeeze', 'pile', 'piles', 'ball', 'balls', 'wedge', 'wedges',
  'chunk', 'chunks', 'floret', 'florets', 'strip', 'strips',
  'block', 'blocks', 'tub', 'tubs', 'box', 'boxes',
]);

// Apply the size rule to one bullet body. Returns { out, didChange }.
function applySizeRule(body) {
  const qtyMatch = body.match(QTY_PREFIX_RE);
  const qty = qtyMatch ? qtyMatch[0] : '';
  const afterQty = body.slice(qty.length);
  const sizeMatch = afterQty.match(SIZE_RE);
  if (!sizeMatch) return { out: body, didChange: false };
  const sizeWord = sizeMatch[1];
  const sizeSuffix = sizeMatch[2] || '';
  const afterSize = afterQty.slice(sizeMatch[0].length);
  // The first word after the size phrase decides whether to fire.
  const nextWordMatch = afterSize.match(/^([a-zA-Z][\w-]*)/);
  if (!nextWordMatch) return { out: body, didChange: false };
  if (NON_INGREDIENT_AFTER_SIZE.has(nextWordMatch[1].toLowerCase())) return { out: body, didChange: false };
  // Skip multi-option lines ("1 large fresh red chilli or 2 medium red
  // chillies") - the trailing alternative would otherwise get pulled
  // into the captured ingredient and "(large)" would dangle at the end
  // of the whole expression. Better to leave these for hand review.
  const orIdx = afterSize.toLowerCase().search(/\s+or\s+/);
  const punctIdx = afterSize.search(/[,(]/);
  if (orIdx !== -1 && (punctIdx === -1 || orIdx < punctIdx)) return { out: body, didChange: false };
  // Split the rest into ingredient phrase + trailing context. The
  // ingredient runs up to the first comma or open paren.
  const splitIdx = afterSize.search(/[,(]/);
  const ingredient = splitIdx === -1 ? afterSize.trimEnd() : afterSize.slice(0, splitIdx).trimEnd();
  const trailing = splitIdx === -1 ? '' : afterSize.slice(splitIdx);
  // Normalise "small-sized" -> "small sized", lowercase.
  const sizePhrase = (sizeWord + sizeSuffix).replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  let rewritten;
  if (trailing.startsWith('(') && trailing.includes(')')) {
    // Merge size into the existing trailing paren.
    rewritten = qty + ingredient + ' ' + trailing.replace(/^\(/, `(${sizePhrase}, `);
  } else if (trailing) {
    // Comma-style trailing - append paren before it.
    rewritten = qty + ingredient + ` (${sizePhrase})` + trailing;
  } else {
    rewritten = qty + ingredient + ` (${sizePhrase})`;
  }
  return { out: rewritten, didChange: rewritten !== body };
}

// Expand "N x M unit" patterns into the multiplied total:
//   "2 x 100 gram balls burrata" -> "200 gram balls burrata"
//   "3 x 50 ml shots vodka"      -> "150 ml shots vodka"
// Both numbers must be integers/decimals. The "x" can be ASCII x/X or
// the unicode multiplication sign.
const MULTIPLIER_RE = /^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(\s*\S.*)$/i;
function applyMultiplierRule(body) {
  const m = body.match(MULTIPLIER_RE);
  if (!m) return { out: body, didChange: false };
  const n = parseFloat(m[1]);
  const v = parseFloat(m[2]);
  if (!Number.isFinite(n) || !Number.isFinite(v)) return { out: body, didChange: false };
  const product = n * v;
  // Render whole-number products as integers, otherwise keep up to 2dp.
  const productStr = Number.isInteger(product) ? String(product) : (Math.round(product * 100) / 100).toString();
  return { out: productStr + m[3], didChange: true };
}

// Append a qualifier inside parens, merging with a trailing balanced
// paren group if one already exists ("4 lemons (washed)" + "zest" ->
// "4 lemons (washed, zest)" rather than two paren groups).
function appendInParens(text, qualifier) {
  text = text.trim();
  const m = text.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m && m[1].trim()) {
    return m[1].trimEnd() + ' (' + m[2] + ', ' + qualifier + ')';
  }
  return text + ' (' + qualifier + ')';
}

// Find a ' - ' separator at paren-depth 0 (outside any parens), with
// substantive text following. Returns the index of the leading space,
// or -1 if not found.
function trailingDashIdx(body) {
  let depth = 0;
  for (let i = 0; i < body.length - 2; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === ' ' && body[i+1] === '-' && body[i+2] === ' ') {
      const after = body.slice(i + 3).trim();
      if (after.length > 0 && /^[A-Za-z]/.test(after)) return i;
    }
  }
  return -1;
}

// Rewrite "ingredient (maybe paren) - annotation" by folding the
// trailing annotation into parens. If a trailing paren group already
// exists, merge into it ("(notes, annotation)"); otherwise wrap.
// Skipped when the annotation itself contains parens, to avoid
// producing nested-paren clutter.
function applyDashAnnotationRule(body) {
  const idx = trailingDashIdx(body);
  if (idx === -1) return { out: body, didChange: false };
  const before = body.slice(0, idx).trimEnd();
  const annotation = body.slice(idx + 3).trim();
  if (!before || !annotation) return { out: body, didChange: false };
  // Safety: skip when the annotation has parens of its own.
  if (/[()]/.test(annotation)) return { out: body, didChange: false };
  return { out: appendInParens(before, annotation), didChange: true };
}

// Find a '/' at paren-depth 0 (outside any parens). Skips slashes
// flanked by digits on both sides ("50/50", "1/4", "2/3") since those
// are numeric, not alternative-separators. Returns the index of the
// slash, or -1 if not found.
function depthZeroSlashIdx(body) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === '/') {
      const prev = body[i - 1] || '';
      const next = body[i + 1] || '';
      if (/\d/.test(prev) && /\d/.test(next)) continue;
      return i;
    }
  }
  return -1;
}

// Wrap "X/Y" or "X / Y" alternative pairs in parens.
//   "Coriander/cilantro"           -> "Coriander (or cilantro)"
//   "Plain/all-purpose Flour"      -> "Plain (or all-purpose) Flour"
//   "Black Caraway / Nigella Seeds"-> "Black Caraway (or Nigella Seeds)"
// Glued slash (no spaces): the alt extends only to the next space, so
// shared trailing nouns stay outside the parens. Spaced slash: the alt
// extends to the next comma or open paren or end-of-line, like the
// or-parens rule.
function applySlashParensRule(body) {
  const idx = depthZeroSlashIdx(body);
  if (idx === -1) return { out: body, didChange: false };
  if (body.slice(0, idx).includes('(')) return { out: body, didChange: false };
  const beforeChar = body[idx - 1] || '';
  const afterChar = body[idx + 1] || '';
  const isGlued = beforeChar !== ' ' && afterChar !== ' ';
  let before, altPhrase, trailing;
  if (isGlued) {
    const rest = body.slice(idx + 1);
    const spaceIdx = rest.search(/[\s,(]/);
    const altEnd = spaceIdx === -1 ? rest.length : spaceIdx;
    before = body.slice(0, idx);
    altPhrase = rest.slice(0, altEnd);
    trailing = rest.slice(altEnd);
  } else {
    const rest = body.slice(idx + 1);
    let endIdx = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === '(' || ch === ',') { endIdx = i; break; }
    }
    before = body.slice(0, idx).trimEnd();
    altPhrase = rest.slice(0, endIdx).trim();
    trailing = rest.slice(endIdx);
  }
  if (!before || !altPhrase) return { out: body, didChange: false };
  // If the trailing starts with a balanced paren group, merge the alt
  // into that paren rather than producing two adjacent paren groups.
  const trimmedTrailing = trailing.replace(/^\s+/, '');
  if (trimmedTrailing.startsWith('(')) {
    const parenEnd = trimmedTrailing.indexOf(')');
    if (parenEnd !== -1) {
      const inner = trimmedTrailing.slice(1, parenEnd);
      const after = trimmedTrailing.slice(parenEnd + 1);
      return {
        out: `${before} (or ${altPhrase}, ${inner})${after}`,
        didChange: true,
      };
    }
  }
  return { out: `${before} (or ${altPhrase})${trailing}`, didChange: true };
}

// Find ' or ' at paren-depth 0 (outside any parens). Returns the
// index of the leading space, or -1 if not found.
function depthZeroOrIdx(body) {
  let depth = 0;
  for (let i = 0; i < body.length - 3; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === ' ' &&
             body[i+1] === 'o' && body[i+2] === 'r' && body[i+3] === ' ') {
      return i;
    }
  }
  return -1;
}

// Wrap "X or Y" alternatives in parens at depth 0:
//   "500 ml beef or chicken stock" -> "500 ml beef (or chicken stock)"
//   "200 g bok choy or napa cabbage" -> "200 g bok choy (or napa cabbage)"
//   "500 ml beef or chicken stock (heated)" -> "500 ml beef (or chicken stock, heated)"
// The alternative phrase extends from "or" up to the next comma or
// open paren, or end-of-line.
function applyOrParensRule(body) {
  const orIdx = depthZeroOrIdx(body);
  if (orIdx === -1) return { out: body, didChange: false };
  // Skip list-pattern lines ("red, yellow, or orange peppers") - the
  // ", or" prefix indicates a third item in an enumeration, not a
  // single binary alternative.
  if (orIdx >= 1 && body[orIdx - 1] === ',') return { out: body, didChange: false };
  // Skip lines that already have parens before the "or" - those have
  // mid-line annotations and wrapping a tail in more parens makes a
  // mess. The user-listed cases never have a mid-line paren.
  if (body.slice(0, orIdx).includes('(')) return { out: body, didChange: false };
  // End of the alternative: next comma or open paren in the rest.
  const rest = body.slice(orIdx);
  let endIdx = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(' || ch === ',') { endIdx = i; break; }
  }
  const before = body.slice(0, orIdx).trimEnd();
  const altPhrase = rest.slice(0, endIdx).trim();
  const trailing = rest.slice(endIdx);
  if (!before || !altPhrase || altPhrase.length < 4) return { out: body, didChange: false };
  // Merge with a following paren group if one immediately follows.
  if (trailing.startsWith(' (') || trailing.startsWith('(')) {
    const parenStart = trailing.indexOf('(');
    const parenEnd = trailing.indexOf(')', parenStart);
    if (parenEnd !== -1) {
      const innerExisting = trailing.slice(parenStart + 1, parenEnd);
      const afterParen = trailing.slice(parenEnd + 1);
      return {
        out: `${before} (${altPhrase}, ${innerExisting})${afterParen}`,
        didChange: true,
      };
    }
  }
  return { out: `${before} (${altPhrase})${trailing}`, didChange: true };
}

// Rewrite "Zest ..." and "Zest and Juice of ..." lines into the
// "<ingredient> (zest)" / "<ingredient> (juice and zest)" form. Also
// folds "Half a"/"Half an" into the "½" symbol and lowercases the
// ingredient text (since "Lemon"/"Orange" get sentence-cased and the
// site keeps ingredient names lowercase outside of headings).
function applyZestRule(body) {
  // Pattern B first - it's the more specific match.
  let m = body.match(/^Zest\s+and\s+Juice\s+of\s+(.+)$/i);
  if (m) {
    let rest = m[1].trim().replace(/^(half\s+an?)\s+/i, '½ ').toLowerCase();
    return { out: appendInParens(rest, 'juice and zest'), didChange: true };
  }
  // Pattern A - "Zest <ingredient>" or "Zest of <ingredient>", with
  // optional size word inside the captured rest.
  m = body.match(/^Zest\s+(?:of\s+)?(.+)$/i);
  if (m) {
    let rest = m[1].trim().replace(/^(half\s+an?)\s+/i, '½ ').toLowerCase();
    const sizeM = rest.match(/^((?:\d+|a|an)\s+)?(small|medium|large)\s+(.+)$/);
    if (sizeM) {
      const qty = sizeM[1] || '';
      const size = sizeM[2];
      const ing = sizeM[3];
      return { out: qty + appendInParens(ing, `${size} - zest`), didChange: true };
    }
    return { out: appendInParens(rest, 'zest'), didChange: true };
  }
  return { out: body, didChange: false };
}

// Rewrite "Juice of <ingredient>" -> "<ingredient> (juice)". Folds
// "Half a/an" into "½" and lowercases the ingredient phrase to match
// the rest of the site's ingredient styling.
function applyJuiceRule(body) {
  const m = body.match(/^Juice\s+of\s+(.+)$/i);
  if (!m) return { out: body, didChange: false };
  let rest = m[1].trim()
    .replace(/^(half\s+an?)\s+/i, '½ ')
    // Strip leftover article after "½" ("½ a lemon" -> "½ lemon").
    .replace(/^(½|¼|¾|⅓|⅔|⅛|⅜|⅝|⅞)\s+an?\s+/i, '$1 ')
    .toLowerCase();
  return { out: appendInParens(rest, 'juice'), didChange: true };
}

// Process one ingredient bullet's content. Returns { out, didChange }.
// Rules applied in order:
//   1. Multiplier expansion (numeric, runs first so 2x100 -> 200 is
//      visible to later rules).
//   2. Zest/juice rewrite (replaces the whole line shape; runs early
//      so the size rule sees the rewritten form).
//   3. Leading-word strip (about/additional/approximately).
//   4. Size-to-parenthesis.
function processIngredientText(text) {
  let s = text;
  let changed = false;
  const multRes = applyMultiplierRule(s);
  if (multRes.didChange) { s = multRes.out; changed = true; }
  const zestRes = applyZestRule(s);
  if (zestRes.didChange) { s = zestRes.out; changed = true; }
  const juiceRes = applyJuiceRule(s);
  if (juiceRes.didChange) { s = juiceRes.out; changed = true; }
  const leadM = s.match(LEADING_WORD_RE);
  if (leadM) { s = leadM[1] + s.slice(leadM[0].length); changed = true; }
  const sizeRes = applySizeRule(s);
  if (sizeRes.didChange) { s = sizeRes.out; changed = true; }
  const dashRes = applyDashAnnotationRule(s);
  if (dashRes.didChange) { s = dashRes.out; changed = true; }
  const orRes = applyOrParensRule(s);
  if (orRes.didChange) { s = orRes.out; changed = true; }
  const slashRes = applySlashParensRule(s);
  if (slashRes.didChange) { s = slashRes.out; changed = true; }
  return { out: s, didChange: changed };
}

// Walk a markdown file's lines. Inside the `## Ingredients` block
// (until the next `## ` heading or EOF), rewrite each bullet line.
// `### Equipment`/`### Tools`/`### Kit`/`### Gear` sub-sections are
// left untouched, matching the build script's skip behaviour.
const EQUIPMENT_SUBSECTION_RE = /^###\s+(equipment|tools|kit|gear)\b/i;

// "Salt and pepper" lines get split into two bullets ("- salt" and
// "- pepper"), with any trailing "to taste" / "(to taste)" stripped.
// Handles common modifier variants ("freshly ground black pepper",
// "cracked pepper", "white pepper").
const SALT_PEPPER_RE = /^salt(?:\s+and\s+|\s*&\s*)(?:fresh(?:ly)?\s+)?(?:cracked\s+|ground\s+|crushed\s+|coarsely\s+ground\s+|freshly\s+ground\s+)?(?:black\s+|white\s+)?pepper(?:\s*,?\s*\(?\s*to\s+taste\s*\)?)?\s*$/i;

function rewriteFile(content) {
  const lines = content.split(/\r?\n/);
  let inIngredients = false;
  let inEquipmentSub = false;
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+ingredients\b/i.test(line)) { inIngredients = true; inEquipmentSub = false; continue; }
    if (inIngredients && /^##\s/.test(line)) { inIngredients = false; inEquipmentSub = false; continue; }
    if (!inIngredients) continue;
    if (/^###\s/.test(line)) { inEquipmentSub = EQUIPMENT_SUBSECTION_RE.test(line); continue; }
    if (inEquipmentSub) continue;

    const m = line.match(/^(\s*-\s+)(.*)$/);
    if (!m) continue;
    const prefix = m[1];
    const body = m[2];

    // Salt+pepper split runs first - it produces TWO bullets, replacing
    // the original. Skip any further per-rule processing on these.
    if (SALT_PEPPER_RE.test(body.trim())) {
      lines[i] = prefix + 'salt';
      lines.splice(i + 1, 0, prefix + 'pepper');
      events.push({ line: i + 1, original: body, out: 'salt\n' + prefix + 'pepper' });
      i++;  // Skip the inserted line; it's already final.
      continue;
    }

    const res = processIngredientText(body);
    if (!res.didChange) continue;
    lines[i] = prefix + res.out;
    events.push({ line: i + 1, original: body, out: res.out });
  }
  return { newContent: lines.join('\n'), events };
}

// ---------- walk + run ----------

function listMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'scripts') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(p));
    else if (entry.isFile() && p.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = listMarkdownFiles(ROOT);
let filesChanged = 0;
let bulletsChanged = 0;
const samples = [];
const SAMPLE_LIMIT = process.env.SAMPLE_LIMIT ? parseInt(process.env.SAMPLE_LIMIT, 10) : 20;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const { newContent, events } = rewriteFile(content);
  if (!events.length) continue;
  filesChanged += 1;
  bulletsChanged += events.length;
  for (const ev of events) {
    if (samples.length < SAMPLE_LIMIT) {
      samples.push({ file: path.relative(ROOT, file), line: ev.line, before: ev.original, after: ev.out });
    }
  }
  if (APPLY) fs.writeFileSync(file, newContent);
}

const mode = APPLY ? 'APPLY' : 'DRY RUN';
console.log(`\n=== ${mode} ===`);
console.log(`Files scanned:   ${files.length}`);
console.log(`Files changed:   ${filesChanged}`);
console.log(`Bullets changed: ${bulletsChanged}`);
if (samples.length) {
  console.log(`\nSample changes (up to ${SAMPLE_LIMIT}):`);
  for (const s of samples) {
    console.log(`  ${s.file}:${s.line}`);
    console.log(`    - ${s.before}`);
    console.log(`    + ${s.after}`);
  }
}
if (DRY_RUN) console.log(`\nRe-run with --apply to write the changes.`);
