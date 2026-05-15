#!/usr/bin/env node
// Walks the repo, parses every recipe markdown file, and writes dist/recipes.json.
// This is the committed artifact the UI fetches from
// raw.githubusercontent.com/<owner>/recipes-content/main/dist/recipes.json.
// Run from anywhere: node scripts/build-manifest.mjs

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, posix, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_PATH = join(REPO_ROOT, 'dist', 'recipes.json');
const CATEGORIES_PATH = join(REPO_ROOT, 'categories.json');
const SUBSTITUTIONS_PATH = join(REPO_ROOT, 'substitutions.json');
const WINE_PAIRINGS_PATH = join(REPO_ROOT, 'wine-pairings.json');
const WINE_PAIRING_LIMIT = 4;
const SIDE_PAIRINGS_PATH = join(REPO_ROOT, 'side-pairings.json');
const SIDE_PAIRING_LIMIT = 6;

const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO', 'editorial']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md']);
const EDITORIAL_DIR = join(REPO_ROOT, 'editorial');

const LABEL_OVERRIDES = {
  'appetizer': 'Appetisers',
  'baking': 'Baking',
  'base-ingredients': 'Base Ingredients',
  'bread-pasta': 'Bread & Pasta',
  'coulis': 'Coulis',
  'cuisine': 'World Cuisine',
  'desert': 'Desserts',
  'petit-four': 'Petit Fours',
  'pies': 'Pies',
  'rice': 'Rice',
  'salad': 'Salads',
  'salsa': 'Salsas',
  'sauces': 'Sauces',
  'sides': 'Sides',
  'soup': 'Soups',
  'sponge': 'Sponges',
  'starter': 'Starters',
  'stocks': 'Stocks',
  'tarts': 'Tarts',
  'vinaigrette': 'Vinaigrettes',
  'BIR': 'BIR',
  'Spice-Mixes': 'Spice Mixes',
};

function toPosix(p) {
  return p.split(sep).join(posix.sep);
}

function titleCase(slug) {
  if (LABEL_OVERRIDES[slug]) return LABEL_OVERRIDES[slug];
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function detectRepoBranch() {
  // Fallback used only when git remote isn't configured (e.g. fresh clone
  // before `git remote add origin`). Once origin is set, the value below
  // is replaced by the parsed remote URL.
  let repo = 'KelsierLuthadel/recipes-content';
  let branch = 'main';
  let commit = null;
  let version = null;
  try {
    const url = execSync('git config --get remote.origin.url', { cwd: REPO_ROOT }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
    if (m) repo = `${m[1]}/${m[2]}`;
  } catch { /* fall back */ }
  try {
    const b = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT }).toString().trim();
    if (b && b !== 'HEAD') branch = b;
  } catch { /* fall back */ }
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim() || null;
  } catch { /* unavailable - manifest just won't show a commit */ }
  try {
    // Most recent tag reachable from HEAD. Fails (and we leave version
    // null) if no tags exist yet; the UI falls back to the commit hash.
    version = execSync('git describe --tags --abbrev=0', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch { /* no tags - skip */ }
  // Prefer package.json's version when it's ahead of the latest tag. The
  // release flow bumps package.json BEFORE tagging, and the manifest
  // should reflect the upcoming version as soon as it's bumped (otherwise
  // the deployed site keeps showing the previous tag until git push --tags).
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    if (pkg.version && (!version || compareSemver(pkg.version, version) > 0)) {
      version = pkg.version;
    }
  } catch { /* unreadable package.json - keep tag-derived version */ }
  return { repo, branch, commit, version };
}

// Walk the git history once to map each tracked file to the ISO timestamp
// of its FIRST addition. Used to populate recipe.addedAt so the home page
// can surface a "Latest recipes" section. A single `git log` covers the
// whole repo in well under a second even at 1400+ files.
// Load addedAt values from an existing manifest. Used as a fallback when
// the git-log derivation produces suspect output (see sanity guard below)
// so CI doesn't overwrite good locally-built timestamps with bad ones.
function loadExistingAddedAt() {
  const map = new Map();
  try {
    const raw = readFileSync(OUT_PATH, 'utf8');
    const m = JSON.parse(raw);
    function walk(node) {
      if (node.recipes) for (const r of node.recipes) if (r.addedAt && r.path) map.set(r.path, r.addedAt);
      if (node.subcategories) for (const s of node.subcategories) walk(s);
    }
    if (Array.isArray(m.categories)) for (const c of m.categories) walk(c);
  } catch { /* no existing manifest or unreadable */ }
  return map;
}

function buildAddedAtMap() {
  const map = new Map();
  let stdout = '';
  try {
    // --no-merges skips merge commits entirely. Without this, a merge commit
    // can be mis-attributed as the "Add" commit for every file in the repo
    // (observed in CI on 2026-05-13: a merge commit's timestamp was stamped
    // on all 1383 recipes, breaking the "Latest" sort completely).
    stdout = execSync(
      'git log --reverse --no-merges --diff-filter=A --name-only --pretty=format:%aI',
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 }
    ).toString();
  } catch {
    return loadExistingAddedAt(); // No git history available; preserve prior values if any.
  }
  let currentTs = null;
  for (const lineRaw of stdout.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line)) {
      currentTs = line;
      continue;
    }
    if (currentTs && !map.has(line)) map.set(line, currentTs);
  }
  // Sanity guard: if more than 80% of mapped files share a single timestamp,
  // the git log output is almost certainly broken (shallow clone, history
  // rewrite, or CI-specific weirdness collapsing everything to one commit).
  // Don't stamp bad data; fall back to whatever addedAt values are already
  // in the committed manifest. Local builds produce good output and CI then
  // carries it forward unchanged.
  let suspect = false;
  if (map.size > 50) {
    const counts = new Map();
    for (const ts of map.values()) counts.set(ts, (counts.get(ts) || 0) + 1);
    const max = Math.max(...counts.values());
    if (max / map.size > 0.8) {
      console.warn(`[buildAddedAtMap] ${max}/${map.size} files share one timestamp; falling back to existing manifest addedAt values`);
      suspect = true;
    }
  }
  if (suspect) {
    const fallback = loadExistingAddedAt();
    if (fallback.size > 0) return fallback;
    return new Map();
  }
  return map;
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

function extractServes(md) {
  const m = md.match(/^\*\*Serves:\*\*\s*(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function extractPrepTime(md) {
  const m = md.match(/^\*\*Prep Time:\*\*\s*(.+?)\s*$/mi);
  return m ? m[1].trim() : null;
}

function extractCookTime(md) {
  const m = md.match(/^\*\*Cook Time:\*\*\s*(.+?)\s*$/mi);
  return m ? m[1].trim() : null;
}

// Accept the heading line in either bare form ("## Ingredients") or
// with a suffix ("## Ingredients (For Dry Spice Mix)") so multi-variant
// recipes still get their ingredients indexed.
function extractIngredientText(md) {
  const m = md.match(/^##\s+Ingredients\b[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/).filter(l => /^-\s/.test(l));
  if (!lines.length) return null;
  return lines
    .map(l => l
      .replace(/^-\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // strip markdown links
      .replace(/\*\*([^*]+)\*\*/g, '$1')          // strip bold
      .replace(/\*([^*]+)\*/g, '$1')              // strip italic
      .replace(/\([^)]*\)/g, '')                  // drop parentheticals (chopped, sliced, etc.)
      .replace(/\s+/g, ' ')
      .trim()
    )
    .filter(Boolean)
    .join(' • ');
}

// Pull canonical ingredient names from each bullet under ## Ingredients.
// Used by the pantry picker to score recipes by overlap with what the
// user has on hand. Canonicalisation is intentionally light: we strip
// quantity + unit + parentheticals + trailing comma clauses, lowercase
// and trim. Plurals are left alone; runtime matching uses substring,
// so "onion" picks up recipes that list "onions" / "red onion" too.
const QTY_RE  = /^\s*(?:\d+(?:[.,/]\d+)?(?:\s+\d+\/\d+)?(?:\s*[½¼¾⅓⅔⅛⅜⅝⅞])?(?:\s*[--]\s*\d+(?:[.,/]\d+)?(?:\s*[½¼¾⅓⅔⅛⅜⅝⅞])?)?|[½¼¾⅓⅔⅛⅜⅝⅞]|half|quarter|a)\s+/i;
const UNIT_RE = /^(?:tablespoons?|teaspoons?|tbsps?|tsps?|cups?|kilograms?|grams?|millilitres?|milliliters?|litres?|liters?|ounces?|pounds?|kg|g|mg|ml|fl\s*oz|oz|lb|lbs|pints?|cloves?|sticks?|pieces?|slices?|sprigs?|handfuls?|pinch(?:es)?|dashes?|knobs?|drops?|splash(?:es)?|cans?|jars?|packets?)\b\.?\s+/i;
const LEADING_OF_RE = /^of\s+/i;
const LEADING_MOD_RE = /^(?:fresh|dried|finely\s+chopped|chopped|crushed|grated|ground|whole|cooked|raw|frozen|tinned|canned)\s+/i;
const TRAILING_NOISE_RE = /\s+(?:to\s+taste|for\s+(?:serving|garnish|frying|drizzling|dusting|sprinkling)|as\s+(?:needed|required))\s*$/i;

function canonicaliseIngredient(line) {
  let s = line
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  s = s.replace(QTY_RE, '');
  s = s.replace(UNIT_RE, '');
  s = s.replace(LEADING_OF_RE, '');
  s = s.replace(LEADING_MOD_RE, '');
  s = s.split(',')[0];
  s = s.replace(TRAILING_NOISE_RE, '');
  s = s.toLowerCase().trim();
  // Drop very short strings (single letters or single short syllables);
  // they're almost always parsing residue ("a", "g") rather than a real
  // ingredient name.
  if (s.length < 3) return null;
  return s;
}

function extractIngredientNames(md) {
  const m = md.match(/^##\s+Ingredients\b[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/).filter(l => /^-\s/.test(l));
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const name = canonicaliseIngredient(l.replace(/^-\s+/, ''));
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// Notes on the patterns:
// - `kidney` and `mince` were dropped (false positives on "kidney beans"
//   and "mushroom mince"); real kidney/minced-meat dishes always list a
//   primary protein elsewhere in their ingredients.
// - Negative lookaheads exclude known plant-context phrases:
//     "beef tomato", "oyster mushroom/sauce", "prawn cracker",
//     "chicken of the woods" (mushroom).
// - Negative lookbehind excludes "Glamorgan/veggie/vegetarian/vegan" before
//   meat words so explicitly-meatless items don't get tagged.
// - Common cuts (rib-eye, sirloin, t-bone, etc.) ensure dishes that name
//   the cut without the protein word still register.
const MEAT_PATTERNS = /(?<!(?:glamorgan|veggie|vegetarian|vegan)\s)(?:\b(?:chicken(?!\s+of\s+the\s+woods)|beef(?!\s+tomato)|pork|lamb|mutton|turkey|duck|goose|venison|rabbit|veal|bacon|sausages?|sausagemeat|salami|pepperoni|pancetta|chorizo|prosciutto|nduja|ham|fillet|steak|cutlet|gammon|brisket|oxtail|tripe|sirloin|tenderloin|t-?bone|ribeye|rib-eye|porterhouse|flank|chuck|short\s+rib|short-rib|skirt\s+steak|hanger|rump\s+steak|topside|silverside|pancett[ae]|guanciale)\b)/i;
const SEAFOOD_PATTERNS = /\b(fish|salmon|tuna|cod|trout|mackerel|haddock|plaice|sole|sea\s?bass|bream|snapper|shrimps?|prawns?(?!\s+crackers?)|lobsters?|crabs?|oysters?(?!\s+(?:mushroom|sauce))|mussels?|clams?|scallops?|squid|octopus|calamari|anchov|sardines?|kippers?|monkfish|halibut|crayfish)\b/i;
const SPICY_PATTERNS = /\b(chill?i(?:es)?|cayenne|jalape[ñn]o|sambal|harissa|sriracha|tabasco|gochujang|piri.?piri|scotch bonnet|bird'?s.?eye|habanero|chipotle|nduja|curry powder|curry paste)\b/i;
const SPICE_LINK_PATTERN = /\/(?:spice-mixes|curry-paste|curry-powder)\//i;
// Animal products beyond meat / seafood - used to disqualify a recipe
// from the "vegan" tag. Eggs / dairy are common edge cases.
const DAIRY_PATTERNS = /\b(milk|butter|buttermilk|cream|cr[eè]me|yogurt|yoghurt|cheese|fromage|paneer|ghee|kefir|quark|skyr|curd|curds|whey|casein|lactose|feta|mozzarella|parmesan|ricotta|mascarpone|cheddar|brie|gruy[èe]re|halloumi|stilton|gorgonzola)\b/i;
const EGG_PATTERNS = /\beggs?\b/i;
const HONEY_PATTERN = /\bhoney\b/i;
// Wheat / gluten-bearing ingredients. Naïve but catches most cases.
const GLUTEN_PATTERNS = /\b(flour|wheat|bread|breadcrumbs?|pasta|noodles|spaghetti|fettuccine|tagliatelle|penne|fusilli|ravioli|tortellini|gnocchi|lasagne|lasagna|barley|bulgur|couscous|semolina|farro|rye|seitan|pastry|cake|biscuits?|crackers?|filo|phyllo|pita)\b/i;
// "make ahead" / "the day before" / "overnight" cues anywhere in the body
// (Method, Notes, Storage). These are recipes that benefit from prep
// the night before or that explicitly note advance preparation.
const MAKE_AHEAD_PATTERNS = /\b(make[- ]ahead|day before|overnight|chill(?:s)?\s+overnight|refrigerate\s+overnight|prepare\s+(?:a|the)\s+day\s+(?:in\s+advance|before)|24\s*hours?|prep\s+ahead)\b/i;
// Single-pan / one-pot / sheet-pan keywords in the title or method intro.
const ONE_PAN_PATTERNS = /\b(one[- ](?:pan|pot|skillet|tray|sheet)|sheet[- ]pan|single[- ]pan|single[- ]pot)\b/i;
// "No cook" / "no-bake" recipes. Scoped to title or notes to keep the
// signal clean (lots of method steps mention "no need to cook" etc.).
const NO_COOK_PATTERNS = /\b(no[- ](?:cook|bake)|raw\b)\b/i;
// BBQ tag. Title-keyword detection covers the obvious grill / smoke /
// kebab / souvlaki / yakitori dishes; an extras list adds the picnic /
// summer-BBQ sides (potato salad, deviled eggs, etc.) and a couple of
// roasted-pork dishes whose titles don't name the method; an excludes
// list drops false positives where a BBQ keyword appears but the dish
// isn't grilled (slow-cooker jerk variants, jerk meatballs, merguez
// pastry rolls).
const BBQ_TITLE_PATTERN = /\b(?:bbq|barbecue|grilled|chargrilled|jerk|souvlaki|yakitori|kebab|kabap|char\s*siu|samgyeopsal|inasal|gai\s+yang|pulled\s+(?:pork|chicken)|asado|bratwurst|boerewors|kielbasa|hot[\s-]?link|smashburger|aussie\s+burger|kofta\s+burger|lamb\s+burger|merguez|chapli|lyulya|piri[\s-]?piri|suya|mixed\s+grill|braai|tandoori?)\b/i;
const BBQ_EXTRA_PATHS = new Set([
  'cuisine/american/side-dishes/potato-salad.md',
  'cuisine/american/side-dishes/watermelon-feta-salad.md',
  'cuisine/american/side-dishes/broccoli-bacon-salad.md',
  'cuisine/american/side-dishes/three-bean-salad.md',
  'cuisine/american/side-dishes/deviled-eggs.md',
  'cuisine/cuban/mojo-pork.md',
]);
const BBQ_EXCLUDE_PATHS = new Set([
  'cuisine/jamaican/slow-cooker-jerk-chicken-tacos.md',
  'cuisine/jamaican/jerk-meatballs.md',
  'cuisine/jamaican/jerk-chicken-nachos.md',
  'cuisine/north-african/snacks/merguez-rolls.md',
  // Ojja is a North African shakshuka-style stew, not a BBQ dish, even
  // though it uses merguez sausage.
  'cuisine/north-african/ojja-merguez.md',
]);
// Path-prefix exclusions: building-block components (marinades, spice
// mixes, pastes, powders) reference BBQ keywords by virtue of what
// they're for, but they're not BBQ dishes in their own right.
const BBQ_EXCLUDE_PREFIXES = [
  'base-ingredients/',
  'cuisine/indian/Spice-Mixes/',
  'cuisine/indian/spice-mixes/',
];
// Path segments under cuisine/ that mean "this is a building block, not a
// finished meal". Folder slugs are already lowercased before matching.
const CUISINE_NON_MEAL_SEGMENT = /^(?:base|breads?|deserts?|desserts?|pastes?|sauces?|pickles?|sauces-pickles|side-dishes?|snacks?|starters?|spices?|mixes?|spice-mixes?|stocks?)$/;
// Top-level cuisine folders that get the 'asian' regional tag.
const ASIAN_CUISINES = new Set(['indian', 'chinese', 'thai', 'vietnamese', 'indonesian', 'malaysian']);
// Allergen detection patterns. Scanned against the Ingredients section
// only (plus the title), same scope as the diet tags. Order matters when
// the same word might trigger more than one allergen (none currently
// overlap). Patterns are deliberately broad; a recipe gets flagged for
// an allergen if any of its forms appear, since this drives both an
// inline highlight and a "don't show me this recipe" toggle.
const ALLERGEN_PATTERNS = {
  gluten:    /\b(?:wheat|flour|bread(?:s|crumbs?)?|pasta|noodles?|spaghetti|fettuccine|tagliatelle|penne|fusilli|ravioli|tortellini|gnocchi|lasagne|lasagna|barley|bulgur|couscous|semolina|farro|rye|seitan|pastry|pita|filo|phyllo|cracker|biscuit|cake)\b/i,
  dairy:     /\b(?:milk|buttermilk|butter|cream|cr[eè]me|yogurt|yoghurt|cheese|paneer|ghee|kefir|quark|skyr|curds?|whey|casein|lactose|feta|mozzarella|parmesan|ricotta|mascarpone|cheddar|brie|gruy[èe]re|halloumi|stilton|gorgonzola|cr[eè]me\s+fra[îi]che)\b/i,
  eggs:      /\beggs?\b/i,
  'tree-nuts': /\b(?:almonds?|walnuts?|pecans?|pistachios?|cashews?|hazelnuts?|macadamias?|brazil\s+nuts?|pine\s+nuts?|chestnuts?|frangipane|marzipan|nutella|praline)\b/i,
  peanuts:   /\b(?:peanuts?|groundnuts?|peanut\s+butter|satay)\b/i,
  soy:       /\b(?:soy|soya|soybeans?|tofu|edamame|tempeh|miso|natto|tamari)\b/i,
  sesame:    /\b(?:sesame|tahini|gomashio|halva)\b/i,
  fish:      /\b(?:fish(?:\s+sauce)?|salmon|tuna|cod|trout|mackerel|haddock|plaice|sole|sea[\s-]?bass|bream|snapper|anchov(?:y|ies)|sardines?|kippers?|monkfish|halibut|pollock|herring|nuoc\s+mam)\b/i,
  shellfish: /\b(?:shrimps?|prawns?|crabs?|lobsters?|crayfish|crawfish|scallops?|mussels?|clams?|oysters?|squid|octopus|calamari|langoustines?)\b/i,
  mustard:   /\b(?:mustards?)\b/i,
  celery:    /\b(?:celery|celeriac)\b/i,
  garlic:    /\bgarlic\b/i,
};
// Specific main-protein tags. Each pattern only fires when the protein
// is in the ingredients block, same heuristic as MEAT_PATTERNS / SEAFOOD_PATTERNS.
// Kept narrow on purpose: a chip that matches 1-2 recipes is just noise
// on the discover picker. Pork covers cured / processed pork products
// (bacon, sausage, chorizo) since those rarely live alongside fresh pork
// in the same recipe and the user mostly cares "is there pig in this".
// Words that mark the protein as a flavouring rather than a main
// ingredient. "chicken stock" / "beef bouillon" / "fish sauce" shouldn't
// tag a recipe as a chicken / beef / fish dish - they're seasonings.
// Applied as a negative lookahead after the protein name.
const FLAVOURING_SUFFIX = String.raw`(?!\s+(?:stock|broth|bouillon|consomm[ée]|powder|paste|cube|cubes|fat|drippings?|seasoning|gravy|jus|sauce|essence|skin|skins|bones?))`;
const PROTEIN_PATTERNS = {
  chicken: new RegExp(String.raw`\bchicken\b(?!\s+of\s+the\s+woods)${FLAVOURING_SUFFIX}`, 'i'),
  beef:    new RegExp(String.raw`\b(?:beef(?!\s+tomato)${FLAVOURING_SUFFIX}|brisket|oxtail|steak|sirloin|tenderloin|t-?bone|ribeye|rib-eye|short\s+rib|skirt\s+steak|chuck|topside|silverside)\b`, 'i'),
  pork:    /(?<!(?:glamorgan|veggie|vegetarian|vegan)\s)\b(?:pork|bacon|pancetta|gammon|chorizo|salami|pepperoni|sausages?|sausagemeat|nduja|prosciutto|ham)\b/i,
  lamb:    new RegExp(String.raw`\b(?:lamb|mutton)\b${FLAVOURING_SUFFIX}`, 'i'),
  duck:    new RegExp(String.raw`\b(?:duck|goose)\b${FLAVOURING_SUFFIX}`, 'i'),
  prawn:   /\b(?:prawns?(?!\s+crackers?)|shrimps?)\b/i,
  salmon:  /\bsalmon\b/i,
};

// Unicode fractions like "1½ hours" need to be normalised to a decimal
// before the minute-parser regex can read them; without this the cook
// time silently reads as zero and a 4-hour recipe gets the `quick` tag.
const TIME_FRACTIONS = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};
const TIME_FRACTION_RE = /(\d+)?\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g;

function timeStringToMinutes(str) {
  if (!str) return 0;
  const s = String(str).replace(TIME_FRACTION_RE, (_, intPart, frac) => {
    const whole = intPart ? parseInt(intPart, 10) : 0;
    return String(whole + TIME_FRACTIONS[frac]);
  });
  let total = 0;
  const hourMatch = s.match(/(\d+(?:\.\d+)?)\s*hour/i);
  const minMatch = s.match(/(\d+(?:\.\d+)?)\s*min/i);
  if (hourMatch) total += parseFloat(hourMatch[1]) * 60;
  if (minMatch) total += parseFloat(minMatch[1]);
  return total;
}

function extractIngredientsBlock(md) {
  const m = md.match(/^##\s+Ingredients\s*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
  return m ? m[1] : '';
}

function deriveAllergens(recipe, md) {
  const ingredients = extractIngredientsBlock(md);
  const hay = recipe.title + '\n' + ingredients;
  const out = [];
  for (const [key, pattern] of Object.entries(ALLERGEN_PATTERNS)) {
    if (pattern.test(hay)) out.push(key);
  }
  return out;
}

function deriveTags(recipe, md) {
  // Diet / spice tags scan ONLY the Ingredients section + title to avoid
  // false positives from prose ("chilli can be added", "serve with bread").
  // Method / make-ahead tags scan the whole document where the signal lives.
  const ingredients = extractIngredientsBlock(md);
  const ingredientsHay = (recipe.title + '\n' + ingredients).toLowerCase();
  const fullHay = (recipe.title + '\n' + md).toLowerCase();
  const tags = [];

  const hasMeat = MEAT_PATTERNS.test(ingredientsHay);
  const hasSeafood = SEAFOOD_PATTERNS.test(ingredientsHay);
  const hasDairy = DAIRY_PATTERNS.test(ingredientsHay);
  const hasEgg = EGG_PATTERNS.test(ingredientsHay);
  const hasHoney = HONEY_PATTERN.test(ingredientsHay);
  const hasGluten = GLUTEN_PATTERNS.test(ingredientsHay);

  if (!hasMeat && !hasSeafood) tags.push('vegetarian');
  if (!hasMeat && !hasSeafood && !hasDairy && !hasEgg && !hasHoney) tags.push('vegan');
  if (!hasDairy) tags.push('dairy-free');
  if (!hasGluten) tags.push('gluten-free');
  if (SPICY_PATTERNS.test(ingredientsHay) || SPICE_LINK_PATTERN.test(ingredientsHay)) tags.push('spicy');

  const total = timeStringToMinutes(recipe.prepTime) + timeStringToMinutes(recipe.cookTime);
  if (total > 0 && total <= 30) tags.push('quick');

  // Folder convention: anything under desert/, dessert/, desserts/ is a
  // sweet ending. Top-level uses "desert" historically; cuisine subfolders
  // use the plural "desserts". Accept any form.
  if (/^(?:deserts?|desserts?)\//.test(recipe.path) || /\/(?:deserts?|desserts?)\//.test(recipe.path)) {
    tags.push('dessert');
  }
  // Folder convention: anything under snacks/ (top-level) or cuisine/.../snacks/
  // is a savoury snack / nibble (distinct from a dessert or a main meal).
  if (/^snacks?\//.test(recipe.path) || /\/snacks?\//.test(recipe.path)) {
    tags.push('snack');
  }
  // Folder convention: cuisine/.../starters/ holds first-course plates -
  // small servings, typically plated, distinct from a snack or a meal.
  if (/^starters?\//.test(recipe.path) || /\/starters?\//.test(recipe.path)) {
    tags.push('starter');
  }

  if (MAKE_AHEAD_PATTERNS.test(fullHay)) tags.push('make-ahead');
  if (ONE_PAN_PATTERNS.test(fullHay)) tags.push('one-pan');
  if (NO_COOK_PATTERNS.test(recipe.title.toLowerCase())) tags.push('no-cook');

  // Path / category-driven tags. Folder names are stable and unambiguous,
  // so these are very low-noise signals.
  const path = recipe.path.toLowerCase();
  const segments = path.split('/');
  if (path.startsWith('baking/')) tags.push('baking');
  if (path.startsWith('sides/') || /\/side-dishes?\//.test(path)) tags.push('sides');
  if (path.startsWith('salsa/')) tags.push('salsa');
  // Meals: anything under cuisine/ is a meal, unless a path segment names
  // a building-block category (sauces, pickles, pastes, spices, breads,
  // stocks, side dishes, mixes, base ingredients). Recipes living
  // explicitly under a 'meals' folder anywhere are always meals.
  const inCuisine = segments[0] === 'cuisine';
  const hasNonMealSegment = segments.some(s => CUISINE_NON_MEAL_SEGMENT.test(s));
  if (segments.some(s => s === 'meals') || (inCuisine && !hasNonMealSegment)) {
    tags.push('meals');
  }
  // Asian: regional umbrella covering the south / south-east / east Asian
  // sub-cuisines we keep under cuisine/.
  if (inCuisine && ASIAN_CUISINES.has(segments[1])) tags.push('asian');
  if (segments.some(s => /^spices?$/.test(s) || /^spice-mixe?s?$/.test(s))) tags.push('spices');
  if (segments.some(s => s.includes('paste'))) tags.push('pastes');

  // BBQ tag: dishes cooked over fire / grill (mains and skewered meats),
  // plus the summer-picnic sides curated via the extras list.
  const bbqExcludedByPrefix = BBQ_EXCLUDE_PREFIXES.some(pfx => recipe.path.startsWith(pfx));
  if (!bbqExcludedByPrefix
    && !BBQ_EXCLUDE_PATHS.has(recipe.path)
    && (BBQ_EXTRA_PATHS.has(recipe.path) || BBQ_TITLE_PATTERN.test(recipe.title))) {
    tags.push('bbq');
  }

  // Ingredient-driven main-protein tags. Reuse the meat / seafood
  // detection we already did for vegetarian / vegan above so the
  // signal stays consistent.
  if (hasMeat) tags.push('meat');
  if (hasSeafood) tags.push('fish');
  // Specific protein chips for the discover picker: chicken, beef,
  // pork, lamb, duck, prawn, salmon. Multiple may fire on the same
  // recipe (e.g. surf-and-turf gets beef + prawn).
  //
  // Per-line filter: any ingredient line that mentions a flavouring
  // form (stock, broth, bouillon, consommé, paste, powder, etc.) is
  // excluded from the protein scan so "100 ml chicken stock" doesn't
  // tag the recipe as a chicken dish. Lines mixing animal names with
  // "or" / "/" (e.g. "veal, chicken or vegetable stock") also get
  // excluded because the protein word is being used as an adjective.
  //
  // Stocks themselves (recipes under stocks/) are skipped entirely:
  // a "chicken stock" recipe is not what someone filtering Discover
  // by "chicken" is looking for, even though chicken is its main
  // ingredient.
  const isStockRecipe = /^stocks\//.test(recipe.path) || /\/stocks\//.test(recipe.path);
  if (!isStockRecipe) {
    const FLAVOURING_LINE = /\b(?:stocks?|broth|bouillon|consomm[ée]|seasoning|gravy|jus|powder|cubes?)\b/i;
    const proteinLines = ingredients
      .split('\n')
      .filter(line => line.trim().startsWith('- '))
      .filter(line => !FLAVOURING_LINE.test(line));
    const proteinHay = (recipe.title + '\n' + proteinLines.join('\n')).toLowerCase();
    for (const [tag, pattern] of Object.entries(PROTEIN_PATTERNS)) {
      if (pattern.test(proteinHay)) tags.push(tag);
    }
  }

  // Curry: title says so, the path lives under a curry-named folder,
  // or the recipe calls for curry powder / paste / leaves.
  const titleLower = recipe.title.toLowerCase();
  if (
    /\bcurry\b/.test(titleLower) ||
    segments.some(s => s.includes('curry')) ||
    /\b(?:curry\s+powder|curry\s+paste|curry\s+leaves)\b/.test(ingredientsHay)
  ) {
    tags.push('curry');
  }

  // Complex: a recipe that takes serious time OR has a long ingredient
  // list. Either signal alone is enough - a 25-ingredient assembly is
  // complex even if it cooks fast, and a 4-hour braise is complex even
  // with 6 ingredients.
  const totalMinutes = timeStringToMinutes(recipe.prepTime) + timeStringToMinutes(recipe.cookTime);
  const ingredientLineCount = (ingredients.match(/^-\s/gm) || []).length;
  if (totalMinutes > 90 || ingredientLineCount > 15) tags.push('complex');

  // Course-exclusivity: a recipe that's a dessert, side, snack, or starter
  // is never also a "meal" in the discover filter sense. The folder-based
  // meals tag above is broad on purpose (anything under cuisine/), so this
  // pass removes the meals tag whenever a more specific course applies.
  if (tags.includes('dessert') || tags.includes('sides') || tags.includes('snack') || tags.includes('starter')) {
    const i = tags.indexOf('meals');
    if (i >= 0) tags.splice(i, 1);
  }

  return tags;
}

function extractImage(md, recipeDir) {
  const m = md.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (!m) return null;
  let p = m[1].trim();
  if (/^https?:/i.test(p)) return p;
  const segments = [];
  for (const part of (recipeDir + '/' + p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

// Mirror of the thumb path emitted by scripts/generate-thumbs.py:
// .../resources/<name>.<ext> -> .../resources/thumbs/<name>.jpg.
// Always JPEG, regardless of source extension. Returns null when the image
// isn't a local resources/ asset (remote URL, or some other layout) so the
// UI falls back to the full image.
function deriveThumbPath(imagePath) {
  if (!imagePath || /^https?:/i.test(imagePath)) return null;
  const m = imagePath.match(/^(.*\/resources)\/([^/]+)$/);
  if (!m) return null;
  const stem = m[2].replace(/\.(jpe?g|png)$/i, '');
  return `${m[1]}/thumbs/${stem}.jpg`;
}

function extractOverview(md) {
  const m = md.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s|$(?![\r\n]))/m);
  if (m) {
    const block = m[1].trim();
    const firstPara = block.split(/\n\s*\n/)[0] || '';
    const text = firstPara.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  // Fallback: many older recipes use a *...* italic caption right under
  // the H1/hero-image instead of an explicit `## Overview` section. Pull
  // the first italic paragraph as the overview so the card still gets
  // descriptive text. Looks for a single-paragraph `*...*` block that
  // starts on its own line; strips the asterisks and joins multi-line
  // captions together.
  const cap = md.match(/^[\t ]*\*([^\n][\s\S]*?)\*[\t ]*$/m);
  if (cap) {
    const text = cap[1].replace(/\s+/g, ' ').replace(/^\*+|\*+$/g, '').trim();
    if (text) return text;
  }
  return null;
}

function ensureNode(root, segments) {
  let node = root;
  const trail = [];
  for (const seg of segments) {
    trail.push(seg);
    let child = node.subcategories.find(c => c.slug === seg);
    if (!child) {
      child = {
        slug: seg,
        path: trail.join('/'),
        label: titleCase(seg),
        subcategories: [],
        recipes: [],
      };
      node.subcategories.push(child);
    }
    node = child;
  }
  return node;
}

function sortTree(node) {
  node.subcategories.sort((a, b) => a.label.localeCompare(b.label));
  node.recipes.sort((a, b) => a.title.localeCompare(b.title));
  for (const c of node.subcategories) sortTree(c);
}

function countRecipes(node) {
  let n = node.recipes.length;
  for (const c of node.subcategories) n += countRecipes(c);
  node.recipeCount = n;
  return n;
}

// Virtual top-level categories: course-based collections that aggregate
// recipes across the cuisine tree by tag, title, or path. They are
// physically empty - no folder of their own - but appear as top-level
// tiles on the home page and as routable category pages (#/c/<slug>).
//
// Each virtual node has `virtual: true` so the front-end's indexManifest
// can skip re-iterating their recipes (the recipes also live in their
// real cuisine subfolders and have already been added to flatRecipes
// from there). Without this flag, every recipe would be double-counted.
const VIRTUAL_CATEGORIES = [
  {
    slug: 'appetizers',
    label: 'Appetisers',
    overview: 'Small dishes designed to start a meal: dips, fritters, savoury pastries, the things you set out before sitting down.',
    match: r => /\/(?:starters?|snacks?)\//.test(r.path),
  },
  {
    slug: 'breakfast',
    label: 'Breakfast',
    overview: 'Morning food and brunch plates: eggs, pancakes, frittata, toasted breads.',
    match: r => /\b(?:pancake|pancakes|eggs\s+benedict|frittata|french\s+toast|shakshuka|akuri|hollandaise|croque\s+monsieur|hash\s+brown|granola|porridge|kedgeree|huevos\s+rancheros|breakfast)\b/i.test(r.title),
  },
  {
    slug: 'desserts',
    label: 'Desserts',
    overview: 'Sweet endings: cakes, custards, ice cream, mousse, sorbets, tarts and pastries.',
    match: r => (r.tags || []).includes('dessert'),
  },
  {
    slug: 'pies',
    label: 'Pies',
    overview: 'Savoury and sweet pies, pasties, and turnovers.',
    match: r => /\bpies?\b|\bpasties?\b|\bturnovers?\b|\bempanada/i.test(r.title),
  },
  {
    slug: 'rice',
    label: 'Rice',
    overview: 'Rice dishes: biryani, pilau, fried rice, risotto, paella, and the everyday staples.',
    match: r => /\/rice\//.test(r.path) || /\b(?:biryani|pilau|paella|risotto|congee|fried\s+rice|steamed\s+rice|coconut\s+rice|jollof|nasi|jambalaya)\b/i.test(r.title),
  },
  {
    slug: 'salads',
    label: 'Salads',
    overview: 'Crisp leaves, composed plates, slaws and dressings.',
    match: r => /\/salads?\//.test(r.path) || /\bsalads?\b|\bslaws?\b|\bsalade\b|\binsalata\b|\btabbouleh\b|\bfattoush\b/i.test(r.title),
  },
  {
    slug: 'salsas',
    label: 'Salsas and Sauces',
    overview: 'Pestos, salsas, raitas, romesco, chutneys and table sauces.',
    match: r => /\bsalsa\b|\bpesto\b|\braita\b|\bromesco\b|\btahina\b|\bchutney\b|\bchimichurri\b|\bgremolata\b/i.test(r.title),
  },
  {
    slug: 'sides',
    label: 'Sides',
    overview: 'Side dishes that round out a plate: potatoes, vegetables, slaws, rice accompaniments.',
    match: r => (r.tags || []).includes('sides'),
  },
  {
    slug: 'snacks',
    label: 'Snacks',
    overview: 'Small bites and sharing plates: dips, dumplings, samosas, fried morsels.',
    match: r => (r.tags || []).includes('snack'),
  },
  {
    slug: 'soups',
    label: 'Soups',
    overview: 'Broths, bisques, chowders, and noodle soups.',
    match: r => /\/soup\//.test(r.path) || /\bsoup\b|\bbisques?\b|\bchowders?\b|\bbroths?\b|\blaksa\b|\bramen\b|\bpho\b|\bgazpacho\b|\bminestrone\b|\bguly[áa]s|\bborscht\b|\bmulligatawny\b|\bcaldo\b/i.test(r.title),
  },
  {
    slug: 'starters',
    label: 'Starters',
    overview: 'First-course recipes: light plates that set the tone for what follows.',
    match: r => /\/starters?\//.test(r.path),
  },
  {
    slug: 'tarts',
    label: 'Tarts',
    overview: 'Sweet and savoury tarts, flans, and quiches.',
    match: r => /\/tarts?\//.test(r.path) || /\btarts?\b|\btarte\b|\bflans?\b|\bquiches?\b/i.test(r.title),
  },
];

function injectVirtualCategories(root, allRecipes) {
  for (const def of VIRTUAL_CATEGORIES) {
    const matches = allRecipes.filter(def.match);
    if (!matches.length) continue;
    root.subcategories.push({
      slug: def.slug,
      path: def.slug,
      label: def.label,
      overview: def.overview,
      virtual: true,
      subcategories: [],
      recipes: matches,
    });
  }
}

function loadCategoryOverviews() {
  try {
    return JSON.parse(readFileSync(CATEGORIES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadSubstitutions() {
  try {
    const raw = JSON.parse(readFileSync(SUBSTITUTIONS_PATH, 'utf8'));
    // Normalise keys to lowercase so runtime lookup can match without
    // re-canonicalising. Values are kept verbatim so authoring stays free.
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      out[key.toLowerCase().trim()] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function loadWinePairings() {
  try {
    const raw = JSON.parse(readFileSync(WINE_PAIRINGS_PATH, 'utf8'));
    return {
      rules: Array.isArray(raw.rules) ? raw.rules : [],
      defaults: raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {},
    };
  } catch {
    return { rules: [], defaults: {} };
  }
}

// Wine pairing matcher. Each rule must satisfy:
//   - every entry in `tags` is on the recipe (AND)
//   - if `anyTags` is set, at least one matches (OR)
//   - if `titleAny` is set, at least one keyword appears in the title (OR)
// Multiple rules can match; their wines are merged (deduped, capped). The
// `note` from the first matching rule wins so we don't concatenate prose.
// Pairings only emit for recipes carrying the 'meals' or 'dessert' tag;
// when no rule matches but the tag is present, fall back to defaults.
function deriveWinePairings(recipe, pairings) {
  const tags = recipe.tags || [];
  const isMeal = tags.includes('meals');
  const isDessert = tags.includes('dessert');
  if (!isMeal && !isDessert) return null;

  const titleLower = (recipe.title || '').toLowerCase();
  const tagSet = new Set(tags);
  const wines = [];
  const seen = new Set();
  let note = null;

  for (const rule of pairings.rules) {
    if (Array.isArray(rule.tags) && !rule.tags.every(t => tagSet.has(t))) continue;
    if (Array.isArray(rule.anyTags) && rule.anyTags.length && !rule.anyTags.some(t => tagSet.has(t))) continue;
    if (Array.isArray(rule.titleAny) && rule.titleAny.length && !rule.titleAny.some(k => titleLower.includes(k.toLowerCase()))) continue;
    for (const w of rule.wines || []) {
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      wines.push(w);
      if (wines.length >= WINE_PAIRING_LIMIT) break;
    }
    if (!note && rule.note) note = rule.note;
    if (wines.length >= WINE_PAIRING_LIMIT) break;
  }

  if (!wines.length) {
    const fallback = isDessert ? pairings.defaults.dessert : pairings.defaults.meals;
    if (!fallback || !Array.isArray(fallback.wines) || !fallback.wines.length) return null;
    return { wines: fallback.wines.slice(0, WINE_PAIRING_LIMIT), note: fallback.note || null };
  }
  return { wines, note };
}

function loadSidePairings() {
  try {
    const raw = JSON.parse(readFileSync(SIDE_PAIRINGS_PATH, 'utf8'));
    return { rules: Array.isArray(raw.rules) ? raw.rules : [] };
  } catch {
    return { rules: [] };
  }
}

// Side-pairing matcher. Each rule lists candidate recipe slugs to suggest
// alongside the current dish (e.g. naan + raita next to a curry). Rule
// matching mirrors deriveWinePairings: `tags` (AND), `anyTags` (OR),
// `titleAny` (OR), plus `pathPrefix` so cuisine-scoped rules are easy.
// Returns an array of slugs that exist in `validSlugs`, deduped and
// capped at SIDE_PAIRING_LIMIT.
//
// Sides themselves don't get pairings: spiced rice has no business
// suggesting roast potatoes. We detect "is this a side recipe" by path
// (top-level sides/, rice/, cuisine/.../breads, cuisine/.../rice).
function isSideRecipe(recipe) {
  const p = (recipe.path || '').toLowerCase();
  if (p.startsWith('sides/')) return true;
  if (p.startsWith('rice/')) return true;
  if (/\/(?:rice|breads?|sauces?|stocks?|pickles?|spices?|spice-mixes?|salsa|coulis|chutney|salads?)\//.test(p)) return true;
  if ((recipe.tags || []).includes('sides')) return true;
  return false;
}

function deriveSidePairings(recipe, sidePairings, validSlugs) {
  if (!sidePairings.rules.length) return null;
  // Sides don't get side-pairings - that produces nonsense suggestions
  // like "spiced rice pairs with mashed potatoes".
  if (isSideRecipe(recipe)) return null;
  const tags = recipe.tags || [];
  const tagSet = new Set(tags);
  const titleLower = (recipe.title || '').toLowerCase();
  const path = (recipe.path || '').toLowerCase();
  const out = [];
  const seen = new Set();
  // Don't suggest a recipe as a side for itself.
  seen.add(recipe.slug);

  for (const rule of sidePairings.rules) {
    if (Array.isArray(rule.tags) && !rule.tags.every(t => tagSet.has(t))) continue;
    if (Array.isArray(rule.anyTags) && rule.anyTags.length && !rule.anyTags.some(t => tagSet.has(t))) continue;
    if (Array.isArray(rule.titleAny) && rule.titleAny.length && !rule.titleAny.some(k => titleLower.includes(k.toLowerCase()))) continue;
    if (rule.pathPrefix && !path.startsWith(String(rule.pathPrefix).toLowerCase())) continue;
    for (const slug of rule.sides || []) {
      if (seen.has(slug)) continue;
      if (!validSlugs.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
      if (out.length >= SIDE_PAIRING_LIMIT) break;
    }
    if (out.length >= SIDE_PAIRING_LIMIT) break;
  }
  return out.length ? out : null;
}

function attachOverviews(node, overviews) {
  if (node.path && overviews[node.path]) node.overview = overviews[node.path];
  for (const c of node.subcategories || []) attachOverviews(c, overviews);
}

// Detect other-recipe mentions in this recipe's body. Drives the
// "Recipes mentioned here" panel on the recipe page. Skips:
//   - the recipe's own H1 (so a recipe titled "Borscht" doesn't list itself)
//   - image markdown (alt text often contains the recipe's own title)
//   - markdown links (we don't want to double-count an existing reference,
//     and the link text would otherwise match)
// A title is only "mentionable" if it's distinctive enough not to false-
// positive on common ingredients: single-word titles that also appear in
// the global ingredient index (>=3 recipes) are dropped, and very short
// single-word titles (<4 chars) are dropped regardless.
function buildMentionTitleIndex(allRecipes, ingredientFreq) {
  const entries = [];
  for (const r of allRecipes) {
    const title = (r.title || '').trim();
    if (!title) continue;
    const lc = title.toLowerCase();
    // Drop very short single-word titles outright (catches "Pho", "Quzi"
    // which are real dishes but too short to disambiguate from arbitrary
    // text). 4-char single words are kept.
    if (!title.includes(' ') && title.length < 4) continue;
    // A title that is itself a common ingredient name is too ambiguous to
    // treat as a mention: every Indian curry that lists "garam masala" in
    // its ingredients would otherwise be tagged as referencing the
    // standalone Garam Masala recipe. This applies to multi-word titles
    // ("Mango Chutney", "Garam Masala") just as much as single-word ones
    // ("Rice", "Bread"). The threshold mirrors ingredientIndex (3+ recipes).
    if (ingredientFreq.has(lc) && ingredientFreq.get(lc) >= 3) continue;
    entries.push({ slug: r.slug, title, lc });
  }
  return entries;
}

function detectMentions(recipe, md, titleIndex) {
  if (!titleIndex.length) return null;
  const body = md
    .replace(/^#\s+.+$/m, '')                  // strip H1 heading
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // strip image markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // unwrap link text; href would also match
  const hay = ' ' + body.toLowerCase() + ' ';
  const found = new Set();
  for (const { slug, lc } of titleIndex) {
    if (slug === recipe.slug) continue;
    const pat = lc
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    // The trailing context excludes both alphanumeric continuations
    // ("Naan" inside "Naans") AND space-then-letter continuations
    // ("White Bread" inside "white bread flour"). Multi-word ingredient
    // names that include a recipe title as a prefix would otherwise be
    // mistaken for a mention of that recipe.
    const re = new RegExp(`(?<![a-z0-9])${pat}(?![a-z0-9])(?!\\s+[a-z])`, 'i');
    if (re.test(hay)) found.add(slug);
  }
  return found.size ? [...found] : null;
}

// Editorial collections: curator-published themed groups of existing
// recipes. Lives under editorial/<slug>.md with simple key/value
// frontmatter and a `## Recipes` list of recipe links. Returns an array
// of collection objects ready to embed in the manifest; recipe links
// that don't resolve to a known path are silently dropped (build still
// succeeds, but the editor sees a warning logged).
function walkEditorial(allRecipes) {
  let entries;
  try { entries = readdirSync(EDITORIAL_DIR, { withFileTypes: true }); }
  catch { return []; }

  // Build a path -> slug lookup so frontmatter links like
  //   [Spaghetti Carbonara](../cuisine/italian/spaghetti-carbonara.md)
  // can resolve to the recipe's canonical slug.
  const slugByPath = new Map();
  for (const r of allRecipes) slugByPath.set(r.path, r.slug);

  const collections = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const filePath = join(EDITORIAL_DIR, entry.name);
    const md = readFileSync(filePath, 'utf8');
    const id = entry.name.replace(/\.md$/, '');

    const parsed = parseFrontmatter(md);
    const fm = parsed.frontmatter;
    const body = parsed.body;
    const title = fm.name || fm.title || id;

    // Image: same resolution path as recipes, anchored against editorial/.
    const image = fm.image ? resolveResource('editorial', fm.image) : extractImage(body, 'editorial');
    const thumb = deriveThumbPath(image);

    // Recipe-list extraction: scan the body for markdown links to .md
    // files, normalise the path relative to editorial/, and look up in
    // the slugByPath map. Falls through any non-resolving link silently.
    const recipeSlugs = [];
    const missing = [];
    const linkRe = /\[[^\]]+\]\(([^)\s]+\.md)\)/g;
    let m;
    while ((m = linkRe.exec(body)) !== null) {
      const target = m[1].trim();
      if (/^https?:/i.test(target)) continue;
      const resolved = normalisePath('editorial', target);
      const slug = slugByPath.get(resolved);
      if (slug) {
        if (!recipeSlugs.includes(slug)) recipeSlugs.push(slug);
      } else {
        missing.push(target);
      }
    }
    if (missing.length) {
      console.warn(`  editorial/${entry.name}: ${missing.length} unresolved link${missing.length === 1 ? '' : 's'} (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''})`);
    }
    if (!recipeSlugs.length) continue;

    collections.push({
      id,
      name: title,
      tagline: fm.tagline || '',
      image,
      thumb,
      publishedAt: fm.publishedat || fm.publishedAt || null,
      // Body with the frontmatter stripped. The recipe-list section is
      // included so the page can render the curator's intro prose AND
      // the list (the list rendering on the page is built from recipeSlugs,
      // not from the body, so the dual representation isn't a problem).
      body,
      recipeSlugs,
    });
  }
  // Newest first by publishedAt. Falls back to filename if no date set.
  collections.sort((a, b) => {
    const aa = a.publishedAt || '';
    const bb = b.publishedAt || '';
    if (aa !== bb) return aa < bb ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  return collections;
}

// Minimal YAML frontmatter parser: opening `---` on first line, closing
// `---` on its own line, single-level `key: value` pairs. Keys are
// lowercased so callers can read case-insensitively.
function parseFrontmatter(md) {
  const lines = md.split('\n');
  if (lines[0] !== '---') return { frontmatter: {}, body: md };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { frontmatter: {}, body: md };
  const fm = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key) fm[key] = value;
  }
  return { frontmatter: fm, body: lines.slice(end + 1).join('\n') };
}

// Resolve a markdown image / link path relative to the given base directory.
// Identical normalisation logic to extractImage's inner block.
function normalisePath(baseDir, target) {
  const segments = [];
  for (const part of (baseDir + '/' + target).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

// Resolve a frontmatter `image:` value: if it's already a full path
// (contains a slash), normalise; otherwise treat as relative to
// `<baseDir>/resources/`.
function resolveResource(baseDir, value) {
  if (!value) return null;
  if (/^https?:/i.test(value)) return value;
  const target = value.includes('/') ? value : 'resources/' + value;
  return normalisePath(baseDir, target);
}

function main() {
  const { repo, branch, commit, version } = detectRepoBranch();
  const rawBase = `https://raw.githubusercontent.com/${repo}/${branch}/`;
  const overviews = loadCategoryOverviews();
  const substitutions = loadSubstitutions();
  const winePairings = loadWinePairings();
  const sidePairings = loadSidePairings();

  const files = walk(REPO_ROOT);
  const addedAtMap = buildAddedAtMap();
  const root = { slug: '', path: '', label: 'All', subcategories: [], recipes: [] };
  // Track every recipe we build so a second pass can resolve cross-recipe
  // references (side pairings, mentions) once all slugs are known.
  const allRecipes = [];
  // Recipe body markdown is held only long enough for the second pass to
  // scan for cross-recipe mentions; it isn't written into the manifest.
  const recipeBodies = new Map();

  let total = 0;
  for (const file of files) {
    const rel = toPosix(relative(REPO_ROOT, file));
    const md = readFileSync(file, 'utf8');
    const title = extractTitle(md);
    if (!title) continue;

    const recipeDir = rel.split('/').slice(0, -1).join('/');
    const slug = rel.replace(/\.md$/, '');

    const image = extractImage(md, recipeDir);
    const recipe = {
      slug,
      title,
      path: rel,
      image,
      thumb: deriveThumbPath(image),
      overview: extractOverview(md),
      serves: extractServes(md),
      prepTime: extractPrepTime(md),
      cookTime: extractCookTime(md),
      ingredients: extractIngredientText(md),
      ingredientNames: extractIngredientNames(md),
    };
    // ISO timestamp of when this markdown was first added to git history.
    // Drives the home page's "Latest recipes" section; omitted when git
    // history is unavailable (e.g. running outside a repo).
    const addedAt = addedAtMap.get(rel);
    if (addedAt) recipe.addedAt = addedAt;
    recipe.tags = deriveTags(recipe, md);
    recipe.allergens = deriveAllergens(recipe, md);
    const wines = deriveWinePairings(recipe, winePairings);
    if (wines) recipe.winePairings = wines;

    const segments = rel.split('/').slice(0, -1);
    const node = ensureNode(root, segments);
    node.recipes.push(recipe);
    allRecipes.push(recipe);
    recipeBodies.set(slug, md);
    total++;
  }

  // Second pass: derive side pairings now that every slug is known. Any
  // slug listed in side-pairings.json that doesn't resolve gets dropped
  // silently (no warning spam) so authors can rename recipes without
  // breaking the build; rules can be cleaned up later.
  const validSlugs = new Set(allRecipes.map(r => r.slug));
  let sidePairCount = 0;
  for (const recipe of allRecipes) {
    const sides = deriveSidePairings(recipe, sidePairings, validSlugs);
    if (sides) {
      recipe.sidePairings = sides;
      sidePairCount++;
    }
  }

  // Ingredient frequency is used to filter the mention title index (so
  // common single-word ingredient names like "Rice" don't trigger false
  // mentions). Built once here, then reused for the public ingredientIndex
  // below.
  const ingredientFreq = new Map();
  for (const r of allRecipes) {
    for (const name of r.ingredientNames || []) {
      ingredientFreq.set(name, (ingredientFreq.get(name) || 0) + 1);
    }
  }

  // Third pass: detect cross-recipe mentions. Stores recipe.mentions as
  // an array of slugs (or omits the field if there are none).
  const titleIndex = buildMentionTitleIndex(allRecipes, ingredientFreq);
  let mentionCount = 0;
  for (const recipe of allRecipes) {
    const md = recipeBodies.get(recipe.slug);
    if (!md) continue;
    const mentions = detectMentions(recipe, md, titleIndex);
    if (mentions) {
      recipe.mentions = mentions;
      mentionCount++;
    }
  }

  injectVirtualCategories(root, allRecipes);

  sortTree(root);
  countRecipes(root);
  for (const c of root.subcategories) attachOverviews(c, overviews);

  // Public ingredient index: { 'onion': 543, ... }. Drives the pantry
  // picker's autocomplete (most common first) so users see useful
  // ingredients to pick from instead of one-off oddities. Limited to
  // entries that appear in 3+ recipes to keep noise out.
  const ingredientIndex = [...ingredientFreq.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  const editorialCollections = walkEditorial(allRecipes);

  const manifest = {
    repo,
    branch,
    commit,
    version,
    rawBase,
    generatedAt: new Date().toISOString(),
    totalRecipes: total,
    categories: root.subcategories,
    ingredientIndex,
    substitutions,
    editorialCollections,
  };

  // dist/ doesn't exist on a fresh clone before this script ever runs, so
  // create it idempotently. Mkdir is recursive + ignores already-exists.
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  ${total} recipes across ${root.subcategories.length} top-level categories`);
  console.log(`  ${ingredientIndex.length} ingredient names indexed (>=3 recipes)`);
  console.log(`  ${Object.keys(substitutions).length} substitution entries loaded`);
  console.log(`  ${winePairings.rules.length} wine-pairing rules loaded`);
  console.log(`  ${sidePairings.rules.length} side-pairing rules loaded; ${sidePairCount} recipes paired`);
  console.log(`  ${titleIndex.length} titles indexed for mentions; ${mentionCount} recipes reference at least one other`);
  const totalEditorialRecipes = editorialCollections.reduce((s, c) => s + c.recipeSlugs.length, 0);
  if (editorialCollections.length) {
    console.log(`  ${editorialCollections.length} editorial collection${editorialCollections.length === 1 ? '' : 's'} (${totalEditorialRecipes} recipe references)`);
  }

  // Keep package.json's version in lockstep with the latest git tag, but
  // sync FORWARD only: if package.json has been manually bumped ahead of
  // the latest tag (e.g. "I just released 0.3.7, bumping to 0.3.8 for
  // the next dev cycle"), leave it alone. Without this, every build
  // would reset the bump.
  if (version) {
    try {
      const pkgPath = join(REPO_ROOT, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (compareSemver(pkg.version || '0.0.0', version) < 0) {
        pkg.version = version;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        console.log(`  Synced package.json version -> ${version}`);
      }
    } catch (err) {
      console.warn(`  Could not sync package.json version: ${err.message}`);
    }
  }

}

// Naive semver comparison (no pre-release / build metadata): -1 if a < b,
// 0 if equal, 1 if a > b. Pads missing parts with zeros.
function compareSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

main();
