# Recipes Content

A multi-cuisine recipe collection. 1,435 recipes across 75 cuisines as markdown, with their images.

Recipes are organised by cuisine under `cuisine/<country>/` with course subfolders (`side-dishes/`, `snacks/`, `desserts/`, `starters/`). Building-block trees (`baking/`, `sauces/`, `stocks/`, `base-ingredients/`, `petit-four/`, `bread-pasta/`, `coulis/`, `sponge/`, `vinaigrette/`) sit alongside. Themed editorial collections live in `editorial/`.

## Running locally

```sh
# lint recipes for missing fields, broken images, etc.
npm run doctor
```

Image maintenance scripts (`generate-thumbs.py`, `resize-images.py`, `touch-portrait-images.py`) need Pillow:

```sh
pip install pillow
```

## Adding a Recipe

The detailed reference is in [documentation/AUTHORING.md](documentation/AUTHORING.md); the quick version:

### 1. Pick the folder

```
cuisine/<country>/                          ← meal goes at the cuisine root
cuisine/<country>/side-dishes/<slug>.md     ← sides
cuisine/<country>/snacks/<slug>.md          ← finger food / starter-snack
cuisine/<country>/starters/<slug>.md        ← first-course plate
cuisine/<country>/desserts/<slug>.md        ← sweet ending
```

The folder name drives the course tag - `desserts/` → `dessert` tag, `snacks/` → `snack`, `side-dishes/` → `sides`, `starters/` → `starter`, root-of-cuisine → `meals`. Don't put a dessert at the cuisine root.

Building-block trees sit outside `cuisine/`: [baking/](baking/), [base-ingredients/](base-ingredients/), [sauces/](sauces/), [stocks/](stocks/), [petit-four/](petit-four/), [bread-pasta/](bread-pasta/), [coulis/](coulis/), [sponge/](sponge/), [vinaigrette/](vinaigrette/). Put genuine components here, not finished plates.

### 2. New cuisine? Create the folder structure

```sh
mkdir -p cuisine/<country>/{resources/thumbs,side-dishes/resources/thumbs,snacks/resources/thumbs,desserts/resources/thumbs}
```

### 3. Write the markdown

The standard template is in [documentation/RECIPE_TEMPLATE.md](documentation/RECIPE_TEMPLATE.md). Authoring conventions:

- **Fractions:** use unicode glyphs - `1 ½ cups`, `½ teaspoon`. The parser also handles `1 1/2` and `1.5`; [scripts/normalize-fractions.mjs](scripts/normalize-fractions.mjs) batch-converts.
- **Units:** metric (g / ml / cm / °C) is the canonical authoring unit.
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

### 5. Lint, commit, push

```sh
npm run doctor
git add -A
git commit -m "<cuisine>: add <recipe>"
git push
```

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

Cover image paths resolve relative to the repo root. Slugs reference existing recipe markdown filenames.

### Seasonal rotation

An editorial collection can additionally claim the home/collections "Seasonal pick" slot for part of the year by adding a `seasonalrange:` field to its frontmatter:

```yaml
---
name: Spring Refresh
tagline: Light, green, and a little bit indulgent.
publishedAt: 2026-05-15
seasonalrange: 03-01..05-31
---
```

Format is `MM-DD..MM-DD`, inclusive, year-agnostic (so the same collection rotates in year after year without re-authoring). Wrapped ranges work too: `12-15..01-10` covers the festive period across year-end. When today's date matches a seasonal range, that collection takes over the slot's title, cover, and recipe list. If no editorial collection claims today, the slot falls back to the hardcoded Summer BBQ default in `docs/modules/state.js`.

Authored seasonal collections so far: `spring-refresh.md`. Buckets the rotation is designed for: Spring (Mar-May), Summer BBQ (Jun-Aug), Fall harvest (mid-Sep-mid-Nov), Thanksgiving (mid-Nov), Christmas (Dec).

## Maintenance scripts

| Script | What it does |
|---|---|
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
