# Recipes Content

The recipe collection — all 1,436 recipes across 75 cuisines, plus the build pipeline that produces the manifest the [recipes-ui](https://github.com/KelsierLuthadel/recipes-ui) frontend consumes.

Recipes are organised by cuisine under `cuisine/<country>/` with course subfolders (`side-dishes/`, `snacks/`, `desserts/`, `starters/`). Building-block trees (`baking/`, `sauces/`, `stocks/`, `base-ingredients/`, `petit-four/`, `bread-pasta/`, `coulis/`, `sponge/`, `vinaigrette/`) sit alongside. Themed editorial collections live in `editorial/`.

## What's in the box

- **Recipe markdown** under each top-level content folder (`cuisine/`, `baking/`, etc.) with per-recipe images in `resources/<slug>.jpg` + 400 px thumbnails in `resources/thumbs/<slug>.jpg`
- **Configuration sidecars** at the repo root:
  - [categories.json](categories.json) — per-cuisine overview text
  - [wine-pairings.json](wine-pairings.json) — wine-pairing rules
  - [side-pairings.json](side-pairings.json) — side-pairing rules
  - [substitutions.json](substitutions.json) — ingredient substitution data
- **Build pipeline** in [scripts/](scripts/) — produces [dist/recipes.json](dist/recipes.json), the single manifest the UI fetches
- **Maintenance scripts** — image fetch, resize, thumbnail generation, em-dash strip, time inference, etc.
- **Authoring guide** in [documentation/AUTHORING.md](documentation/AUTHORING.md) + [documentation/RECIPE_TEMPLATE.md](documentation/RECIPE_TEMPLATE.md)

## How the UI finds the content

The UI ([recipes-ui](https://github.com/KelsierLuthadel/recipes-ui)) is a static site deployed independently. At load it fetches `dist/recipes.json` from this repo over `raw.githubusercontent.com`. The manifest's `rawBase` field then drives every per-recipe markdown and image fetch back here.

So a content edit flows:

1. Author commits a recipe markdown change here.
2. `npm run build` (or the GitHub Action) regenerates `dist/recipes.json`.
3. The commit is pushed; raw.githubusercontent.com serves the new manifest within seconds.
4. UI users see the change on their next page load.

No UI redeploy is needed for content-only changes.

## Running locally

```sh
# rebuild the manifest after adding or editing recipes
npm run build

# lint recipes for missing fields, broken images, etc.
npm run doctor
```

Python image utilities (`generate-thumbs.py`, `resize-images.py`, `touch-portrait-images.py`) need Pillow:

```sh
pip install pillow
```

## Adding a Recipe

The end-to-end workflow for a new dish. The detailed reference is in [documentation/AUTHORING.md](documentation/AUTHORING.md); the quick version:

### 1. Pick the folder

```
cuisine/<country>/                          ← meal goes at the cuisine root
cuisine/<country>/side-dishes/<slug>.md     ← sides
cuisine/<country>/snacks/<slug>.md          ← finger food / starter-snack
cuisine/<country>/starters/<slug>.md        ← first-course plate
cuisine/<country>/desserts/<slug>.md        ← sweet ending
```

The folder name drives the course tag — `desserts/` → `dessert` tag, `snacks/` → `snack`, `side-dishes/` → `sides`, `starters/` → `starter`, root-of-cuisine → `meals`. Don't put a dessert at the cuisine root; the manifest will tag it as a meal.

Building-block trees sit outside `cuisine/`: [baking/](baking/), [base-ingredients/](base-ingredients/), [sauces/](sauces/), [stocks/](stocks/), [petit-four/](petit-four/), [bread-pasta/](bread-pasta/), [coulis/](coulis/), [sponge/](sponge/), [vinaigrette/](vinaigrette/). Put genuine components here, not finished plates.

### 2. New cuisine? Create the folder structure

```sh
mkdir -p cuisine/<country>/{resources/thumbs,side-dishes/resources/thumbs,snacks/resources/thumbs,desserts/resources/thumbs}
```

Then add an overview line for the new cuisine to [categories.json](categories.json) — a 1-2 sentence description that appears on the cuisine's category page header.

### 3. Write the markdown

The standard template is in [documentation/RECIPE_TEMPLATE.md](documentation/RECIPE_TEMPLATE.md). Authoring conventions:

- **Fractions:** use unicode glyphs — `1 ½ cups`, `½ teaspoon`. The parser also handles `1 1/2` and `1.5`; [scripts/normalize-fractions.mjs](scripts/normalize-fractions.mjs) batch-converts.
- **Units:** metric (g / ml / cm / °C). The UI has a Metric → Imperial toggle, so don't write both.
- **No em-dashes** anywhere user-facing. Use ` - ` (hyphen with spaces) or rephrase with a colon. [scripts/strip-em-dashes.mjs](scripts/strip-em-dashes.mjs) cleans up leftovers.
- **Image alt text** should be the recipe title, not `Name` (the template placeholder). [scripts/fix-placeholder-alt.mjs](scripts/fix-placeholder-alt.mjs) cleans up `![Name]` leftovers.

### 4. Add an image + thumbnail

```sh
# main image: <=900px wide, JPEG quality 85
# thumbnail: 400px wide, JPEG quality 80
python scripts/generate-thumbs.py
```

Bulk image fetch from Pexels for missing images:

```sh
PEXELS_API_KEY=xxxx node scripts/fetch-missing-images.mjs
```

### 5. Rebuild the manifest

```sh
npm run build
```

Commit the regenerated `dist/recipes.json` along with your recipe changes.

## Editorial collections

Curator-published themed groups of existing recipes. Live in [editorial/](editorial/) as `<slug>.md` files. Frontmatter shape:

```yaml
---
id: friday-night-wins
name: Friday Night Wins
tagline: Quick, big-flavour cooking for the end of the week
cover: cuisine/italian/resources/spaghetti-aglio.jpg
recipes:
  - spaghetti-aglio-olio
  - thai-green-curry
  - ...
---

Optional intro markdown paragraph(s).
```

Broken recipe references are dropped at build with a warning. Cover image paths resolve relative to the repo root.

## Maintenance scripts

| Script | What it does |
|---|---|
| `build-manifest.mjs` | Builds `dist/recipes.json` from all content. |
| `recipe-doctor.mjs` | Lints recipes: missing images, broken links, missing fields. |
| `fetch-missing-images.mjs` | Pexels image fetch for recipes with no/broken images. |
| `resize-images.py` | Resizes any image >900 px wide to 900 px, JPEG q85. Non-destructive. |
| `generate-thumbs.py` | 400 px thumbs into `resources/thumbs/`. Idempotent. |
| `check-image-widths.mjs` | Reports images over a given width. |
| `normalize-fractions.mjs` | Batch-converts `1/2` → `½`. |
| `normalize-times.mjs` | Standardises prep/cook time formats. |
| `infer-times.mjs` | Auto-infers missing prep/cook times. |
| `strip-em-dashes.mjs` | Removes em-dashes from recipe markdown. |
| `fix-placeholder-alt.mjs` | Replaces `![Name]` placeholder alt text with the recipe title. |
| `audit-images.mjs` | Reports recipes whose images look suspect (size/aspect). |

## Release process

Content has its own release cycle independent of the UI. A typical content release is just:

```sh
npm run build               # regenerate dist/recipes.json
npm run doctor              # lint
git add -A
git commit -m "content: ..."
git push
```

The committed `dist/recipes.json` becomes the live manifest within seconds via raw.githubusercontent.com. No tag, no version bump, no UI redeploy needed.

For larger content releases that warrant a tag, prefix with `content-` to avoid colliding with UI tags:

```sh
git tag content-2026-05-15
git push --tags
```
