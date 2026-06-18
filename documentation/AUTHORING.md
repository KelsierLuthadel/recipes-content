# Authoring Guide

How to add new recipes, cuisines, or supporting data to this repository.

## Adding a recipe

### 1. Pick a folder

Recipes live as markdown files in folders that match their category. The folder structure is the navigation:

| Folder | Use for |
|---|---|
| `cuisine/<country>/` | Country-specific dishes (curry, ramen, paella, etc.). Use the existing folder if the cuisine is already represented. |
| `desert/` | Sweets and desserts. (The folder is spelled "desert" historically; keep it.) |
| `meat/`, `chicken/`, `fish/` | Protein-focused mains that don't fit a specific cuisine. |
| `sides/` | Side dishes. |
| `starter/` | Starters, appetisers, small plates. |
| `breakfast/`, `snacks/` | Self-explanatory. |
| `bread-pasta/`, `salad/`, `salsa/`, `sauces/`, `soup/`, `vinaigrette/` | Single-purpose categories. |

### 2. Create the file

Copy [`RECIPE_TEMPLATE.md`](RECIPE_TEMPLATE.md) or any nearby recipe as a starting point. Use kebab-case for the filename: `chana-masala.md`, not `Chana Masala.md`.

A recipe must have:

```markdown
# Recipe Title

![Recipe Title](resources/recipe-title.jpg)
*One- or two-sentence italic caption describing the dish.*

**Serves:** 4

**Prep Time:** 15 minutes

**Cook Time:** 30 minutes

## Overview
A short paragraph explaining the technique.

## Ingredients

- 1 quantity unit name (with optional parenthetical notes)
- ...

## Method

### Stage 1 - Name
1. Numbered steps using `1.` for every line.

## Notes
- **Topic:** Useful tips, common pitfalls, why something matters.

## Storage
- How long it keeps and how to reheat or freeze.
```

The build script reads the title (`# H1`), the metadata fields, the Overview paragraph, and parses the Ingredients block to build the manifest. Anything below `## Method` is loaded on demand on the recipe page.

### 3. Add an image

Drop a `.jpg` or `.png` into the recipe's sibling `resources/` folder (e.g. `cuisine/indian/resources/chana-masala.jpg`) and reference it as `![Title](resources/chana-masala.jpg)` directly under the `# H1`.

Hero images are curated by hand. There is no bulk-fetch helper; source the file yourself, drop it in `resources/`, and write the markdown link.

## Tags

Tags are derived automatically by [`scripts/build-manifest.mjs`](../scripts/build-manifest.mjs): you don't write them yourself. They're computed from:

- **Ingredients block**: diet tags (`vegetarian`, `vegan`, `gluten-free`, `dairy-free`, `spicy`), allergen tags (`gluten`, `dairy`, `eggs`, `tree-nuts`, `peanuts`, `soy`, `sesame`, `fish`, `shellfish`, `mustard`, `celery`, `garlic`), and protein tags (`chicken`, `beef`, `pork`, `lamb`, `duck`, `prawn`, `salmon`, `meat`, `fish`).
- **Recipe title and ingredients**: `curry`, `complex`.
- **Folder path**: `meals` (anything under `cuisine/`), `dessert`, `baking`, `sides`, `salsa`, `asian` (umbrella for South / South-East / East Asian cuisines), `spices`, `pastes`.
- **Prep + cook time**: `quick` (≤30 minutes total), `complex` (>90 minutes).
- **Method body**: `make-ahead`, `one-pan`, `no-cook`.

If your recipe gets the wrong tags:

- The detection scans the recipe **title** + the Ingredients block only (not the Method or Notes).
- Common false positives have been guarded: "kidney beans", "mushroom mince", "oyster mushroom/sauce", "prawn cracker", "beef tomato", "Glamorgan/veggie/vegetarian/vegan sausages". If you're hitting a new false positive, edit the patterns in [`scripts/build-manifest.mjs`](../scripts/build-manifest.mjs) (`MEAT_PATTERNS`, `SEAFOOD_PATTERNS`, `ALLERGEN_PATTERNS`, `PROTEIN_PATTERNS`).
- Wording your ingredient line slightly differently is often the fastest fix, `oyster mushroom` instead of `oyster, shiitake`, etc.

## Adding a new cuisine

If you're adding a country that doesn't have a folder yet:

1. Create `cuisine/<country>/` and drop your first recipe in.
2. Open [`categories.json`](../categories.json) and add an overview paragraph in the same tone as the existing entries:

```json
"cuisine/<country>": "Two or three sentences on the cuisine's defining flavours and techniques."
```

The overview shows on the cuisine's category tile and at the top of its category page. Keep it punchy.

## Side and wine pairings (optional)

Pairings are rule-based and live in JSON at the repo root:

- [`wine-pairings.json`](../wine-pairings.json): wines suggested for meals and desserts. Match by `tags`, `anyTags`, `titleAny`, plus `pathPrefix`.
- [`side-pairings.json`](../side-pairings.json): side-dish recipe slugs to suggest alongside a meal. Sides themselves don't get pairings (a side never suggests another side).

If a recipe slug listed in `side-pairings.json` doesn't exist, it's silently dropped at build time.

## Substitutions

[`substitutions.json`](../substitutions.json) maps a traditional ingredient (e.g. `"double cream"`) to one or more swap suggestions. The recipe page automatically inserts a "swap" button on any ingredient line that mentions a key. Keys match by substring; longest match wins.

## Required scripts

After adding or editing recipes, run these from the repo root:

| Script | When to run | What it does |
|---|---|---|
| `npm run build` | After **any** recipe / pairings / category / substitution change. | Rebuilds [`docs/recipes.json`](../docs/recipes.json) from the markdown tree. The site reads this; without it, your changes don't show up. |
| `npm run doctor` | Before submitting a PR; periodically. | Lints recipes for missing fields, malformed metadata, broken image links, and other authoring issues. Catches things the build doesn't reject but that look broken on the site. |
| `npm test` | Before submitting a PR. | Runs the unit tests for the parsers (time, scaling, routes, etc.). |
| `npm run stamp` | **Just before a release.** Bump `package.json` first. | Rewrites every relative ES-module import in `docs/` to include `?v=<version>`. Without this, iOS Safari caches old inner module URLs and users see Frankenstein code after a release. Tests keep passing with stamped imports, `scripts/test-loader.mjs` strips `?v=` query strings during Node's resolution. |
| `npm run unstamp` | Rarely. | Removes `?v=` from imports if you want clean diffs while editing. Tests don't require it. |

The CI workflow rebuilds the manifest automatically on push, so `docs/recipes.json` doesn't need to be committed, but locally `npm run build` lets you preview your changes against the site (`npm run dev` then open http://localhost:8000/).

### Release flow

```sh
# 1. Bump version in package.json (e.g. 0.5.0 → 0.5.1)
# 2. Edit CHANGELOG.md (prepend a new dated section)
npm test                 # all tests pass
npm run build            # rebuild manifest
npm run stamp            # apply ?v=<version> to every import
git add -A && git commit
git tag 0.5.1 && git push --tags
```

The order matters: run tests **before** stamping (stamped imports break Node's module loader for tests), and stamp **before** committing (the stamped imports are what get deployed).

## Quick checklist

- [ ] New `.md` file in the right folder, named in kebab-case
- [ ] H1 title, italic caption, image link
- [ ] Serves / Prep Time / Cook Time fields
- [ ] Overview paragraph
- [ ] Ingredients section (one item per `-` bullet)
- [ ] Method section with `### Stage X, Name` sub-headings and `1.`-numbered steps
- [ ] Notes and Storage sections
- [ ] Image saved to sibling `resources/` folder
- [ ] If new cuisine: overview added to `categories.json`
- [ ] `npm run build` to refresh the manifest
- [ ] `npm run doctor` to catch issues
- [ ] `npm test`

## Site preview

```sh
npm run dev
```

Serves [`docs/`](../docs/) at http://localhost:8000 with caching disabled. Edits to markdown files require `npm run build` to be visible; edits to `docs/*.js` and `docs/css/*.css` are picked up on reload.
