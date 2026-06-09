# Recipe workflow

How to add, update, and delete recipes in this repo, and what runs automatically when you do.

This document describes the workflow for the **SvelteKit** build (the [`recipes-ui-next/`](https://github.com/KelsierLuthadel/recipes-ui-next) sibling repo). For the legacy vanilla build, see [`documentation/AUTHORING.md`](documentation/AUTHORING.md).

---

## TL;DR

```sh
# In recipes-content/:
# 1. Create or edit <slug>.md (this is the only source of truth).

# In recipes-ui-next/:
# 2. Run the build:
npm run build-manifest
```

That's it. Step 2 rebuilds `static/recipes.json` from the markdown bodies AND regenerates the `.yml` sidecars to match. The two-script chain is part of `build-manifest`; you never need to invoke them separately.

---

## File layout: `.md` vs `.yml`

Every recipe has two files in the same folder:

```
cuisine/indian/Spice-Mixes/
  chaat-masala.md      ← source of truth (you edit this)
  chaat-masala.yml     ← derived snapshot (generated; do not edit by hand)
```

- **`.md`** holds the recipe prose: title, byline, hero image link, Overview, Ingredients, Method, Notes. This is the only file an author edits.
- **`.yml`** is a machine-readable snapshot of the recipe's structured fields (prep / cook times, allergens, tags, mentions, parsed ingredient list). It's regenerated from the `.md` body by the build. Hand-edits will be overwritten on the next build, so don't.

The `.yml` sidecar isn't used by the build itself — the build reads the `.md` body. The sidecar exists as a checked-in snapshot for external tooling, audit trails, and reviewable diffs of derived data.

---

## Adding a recipe

### What you do

1. **Pick the folder.** Recipes live under a folder matching their category. See [`README.md`](README.md) and [`documentation/AUTHORING.md`](documentation/AUTHORING.md) for the folder-to-tag conventions (e.g. `cuisine/indian/desserts/` → recipe gets the `dessert` tag).

2. **Create `<slug>.md`** following the template in [`documentation/RECIPE_TEMPLATE.md`](documentation/RECIPE_TEMPLATE.md):

   ```markdown
   # Recipe Title

   ![Recipe Title](resources/slug.jpg)

   *One-line italic caption shown under the title on the recipe page.*

   ## Overview
   A paragraph or two describing the dish.

   **Serves:** 4
   **Prep Time:** 15 minutes
   **Cook Time:** 30 minutes

   ## Ingredients
   - 200 g flour
   - 1 tsp salt
   - 250 ml water

   ## Method

   ### Stage 1 - Mix
   1. Combine dry ingredients.
   2. Add water, mix until smooth.

   ## Notes
   - Optional: rest the dough for 30 minutes for a softer texture.
   ```

3. **Add the image** (see [Adding an image to a recipe](#adding-an-image-to-a-recipe) below for the full image workflow).

4. **Run the build** from `recipes-ui-next/`:

   ```sh
   npm run build-manifest
   ```

5. **Commit** `<slug>.md` + `<slug>.yml` + image assets together.

### What the build does

- **Reads `<slug>.md`.** The body is the only source of truth.
- **Extracts structured fields**: title, overview, serves, prep/cook/total time, ingredients block, method.
- **Derives** allergens (regex scan of the ingredient block), tags (folder path + body keywords + festival map), protein, mentions (cross-recipe title matches in the body), and the traditional category path.
- **Parses each ingredient line** into `{ qty, unit, name }` triples for the shopping page (lands in `static/recipe-extras.json`).
- **Writes `static/recipes.json`** (the runtime manifest the SvelteKit app fetches).
- **Writes `<slug>.yml`** next to the `.md` with the derived snapshot. You don't author this file; it's regenerated every build.
- **Picks up the hero image + thumb** if they exist at the expected paths; the manifest stores their paths as relative references and the UI prefixes `rawBase` (raw.githubusercontent.com) at render time.
- **Attaches the BlurHash** from `scripts/image-blurhashes.json` if there's an entry for this slug. See image tutorials below for how to generate one.

---

## Updating a recipe

### What you do

1. **Edit `<slug>.md` only.** Don't touch `<slug>.yml`. Every structured field (allergens, tags, prep/cook times, ingredient list, mentions) is derived from the body, so editing a `**Prep Time:**` line or an ingredient bullet flows through automatically.

2. **Run the build** from `recipes-ui-next/`:

   ```sh
   npm run build-manifest
   ```

3. **Commit `<slug>.md` + `<slug>.yml` together.** Any body change that affects structured data also changes the `.yml`; the two should always travel as one diff.

> **Don't hand-edit `<slug>.yml`.** Any manual change is overwritten on the next `npm run build-manifest`. If you want to change a derived field, change the body line that produces it.

### What the build does

- **Re-derives** every structured field from the new `.md`. Same passes as for a fresh recipe.
- **Diff-aware sidecar write**: the regen script reads the current `<slug>.yml` on disk and only rewrites it when the derived content actually changed. Re-running the build on an unchanged repo is a no-op in git.
- **Cascading mentions**: if you changed the title or removed a recipe, other recipes' `mentions:` arrays update on this build. You may see unrelated `.yml` files in the diff; that's the cascade, not stray edits.
- **`npm run check:sync`** runs the same pipeline in dry-run mode and exits non-zero if any `.yml` would change. Use it as a CI gate or pre-commit hook to catch "forgot to rebuild".

---

## Adding an image to a recipe

A new recipe needs three image artefacts:

| Path | Size | Purpose |
|---|---|---|
| `recipes-content/<dir>/resources/<slug>.jpg` | full-size hero | recipe page header |
| `recipes-content/<dir>/resources/thumbs/<slug>.jpg` | 400 px wide | grid card thumbnails |
| `recipes-ui-next/scripts/image-blurhashes.json` entry | 28-char string | placeholder while the real image loads |

### What you do

1. **Source the image.** Drop your own file at `recipes-content/<dir>/resources/<slug>.jpg`, or fetch from Unsplash:

   ```sh
   # From recipes-content/. --filter scopes the fetch to one recipe.
   UNSPLASH_ACCESS_KEY=xxxx node scripts/fetch-images.mjs --apply --filter <slug>
   ```

   The file MUST be at `<recipe-dir>/resources/<slug>.jpg` where `<slug>` matches the recipe's `.md` filename. The build derives the image path from the body's `![](resources/...)` link, so filenames must agree.

2. **Add the markdown link** in `<slug>.md`, two lines below the H1:

   ```markdown
   # Recipe Title

   ![Recipe Title](resources/slug.jpg)

   *Italic byline...*
   ```

   `fetch-images.mjs --apply` does this insertion automatically; manual drops need the link added by hand.

3. **Generate the thumbnail** from `recipes-content/`:

   ```sh
   python scripts/generate-thumbs.py
   ```

   Walks every `resources/*.jpg` and writes a 400 px-wide JPEG into the sibling `resources/thumbs/`. Skips up-to-date thumbs, so re-running is cheap. Scope to one directory with `--dir cuisine/indian/desserts`.

4. **Generate the BlurHash entry.** This script lives in the legacy vanilla repo and is the one cross-repo step:

   ```sh
   # Run from recipes-ui/, not recipes-ui-next/.
   cd recipes-ui
   python scripts/extract-blurhashes.py --out ../recipes-ui-next/scripts/image-blurhashes.json
   ```

   The `--out` path is relative to your current working directory; the example above writes straight into the next-build location. Re-running is incremental: only new slugs get encoded unless you pass `--force`.

5. **Run the build** from `recipes-ui-next/`:

   ```sh
   npm run build-manifest
   ```

6. **Commit** the new hero, the new `thumbs/<slug>.jpg`, the updated `image-blurhashes.json`, the body change with the `![](...)` link, and the regenerated `.yml`.

### What the build does

- **Resolves the image path** from the body's `![](resources/...)` link and stores it on `recipe.image` in the manifest.
- **Auto-points `recipe.thumb`** at `<dir>/resources/thumbs/<stem>.jpg` whenever that file exists on disk. If the thumb is missing the field stays unset and the UI falls back to the full image (slower first paint, no broken-image icon).
- **Attaches the BlurHash** from `scripts/image-blurhashes.json` if there's an entry for this slug. The UI decodes it into a tiny canvas-rendered placeholder so cards paint the moment the HTML loads, well before the real image arrives.
- **Does not fetch, resize, or compress images.** All three image scripts are manual, content-side operations. The build only references files that already exist.
- **Does not touch IMAGE_CREDITS.** The Unsplash fetcher used to write an attribution file; that step is disabled by convention. Credit is curated by hand after a fetch run.

---

## Updating a recipe image

You're replacing a hero with a better one (different source, better crop, higher resolution).

### What you do

1. **Swap the source image.** Two paths:

   - **From Unsplash, automatic:**
     ```sh
     # From recipes-content/. Moves the old file into a sibling old/ folder
     # (preserving filename) and downloads the top match into the original path.
     UNSPLASH_ACCESS_KEY=xxxx node scripts/refresh-image.mjs "<recipe title substring>"
     UNSPLASH_ACCESS_KEY=xxxx node scripts/refresh-image.mjs "<title>" --query "<custom search>"
     ```
     Bulk: `--dir cuisine/chinese` walks every `.md` under the directory.

   - **Manual replace:**
     ```sh
     mv <dir>/resources/<slug>.jpg <dir>/resources/old/<slug>.jpg
     cp ~/Downloads/new-shot.jpg <dir>/resources/<slug>.jpg
     ```

   The filename stays the same so the existing `![](...)` link still resolves; no body edit needed.

2. **Regenerate the thumb** from `recipes-content/`:

   ```sh
   python scripts/generate-thumbs.py --force --dir <dir>/<that-recipe-folder>
   ```

   `--force` is necessary because the script otherwise skips thumbs newer than the source mtime. `--dir` keeps the rebuild scoped so unrelated thumbs stay untouched.

3. **Regenerate the BlurHash** for the changed image:

   ```sh
   # From recipes-ui/.
   python scripts/extract-blurhashes.py --force --out ../recipes-ui-next/scripts/image-blurhashes.json
   ```

   `--force` rebuilds every entry. For a single-slug refresh you can hand-edit `image-blurhashes.json` to delete the changed slug's row, then re-run without `--force` (only missing slugs get re-encoded).

4. **Run the build** from `recipes-ui-next/`:

   ```sh
   npm run build-manifest
   ```

5. **Commit** the new hero, the regenerated thumb, and the updated `image-blurhashes.json` entry. The `.md` and `.yml` usually stay unchanged (filename unchanged, derived data unchanged).

### What the build does

- **No detection of an image change**, by design. The build references whatever file sits at `<dir>/resources/<slug>.jpg` at build time. Filename unchanged = manifest entry unchanged.
- **Re-picks up the updated thumb + BlurHash** because both are read fresh from the content repo and the JSON file on every build.
- **Cloudflare cache rotation**: the deployed image URL is `<rawBase><dir>/resources/<slug>.jpg`. Cloudflare's edge caches it; the new commit hash in `rawBase` invalidates the cached path on the next deploy, so users see the new image without a hard refresh.

> If you change the image's **filename** (not just its bytes), edit the markdown `![](resources/...)` link to match and re-run the build. The manifest's `image` / `thumb` fields are derived from whatever filename the body points at; a renamed file with a stale link produces a broken-image placeholder.

---

## Deleting a recipe

1. **Delete both files:**

   ```sh
   rm cuisine/indian/Spice-Mixes/chaat-masala.md
   rm cuisine/indian/Spice-Mixes/chaat-masala.yml
   ```

   And the image assets if no other recipe links to them.

2. **Check for cross-references.** Other recipes' `.yml` files may list this slug in their `mentions:` array. Search the catalogue:

   ```sh
   grep -rl "tutorials/bread/gluten" .  # for example
   ```

   The build will rewrite those files' `mentions:` entries on the next run (the regen script drops stale slugs that no longer exist). No manual fixing needed, but you may see a flurry of unrelated `.yml` updates in your diff — that's the cascade.

3. **Run the build:**

   ```sh
   npm run build-manifest
   ```

4. **Commit the deletions + any cascading `.yml` updates.**

---

## The scripts

All scripts run from `recipes-ui-next/`. They expect the `recipes-content/` repo to be a sibling directory (`../recipes-content/`).

| Command | What it does | When to run |
|---|---|---|
| `npm run build-manifest` | Builds `static/recipes.json` from `recipes-content/**/*.md`, then regenerates every `.yml` sidecar that has drifted from its `.md`. The chained command is the **one command you usually need**. | After any recipe change (add / update / delete). |
| `npm run check:sync` | Same as `build-manifest` but the regen step runs in `--check` mode: it doesn't write, just exits non-zero if any `.yml` would drift. Lists the drifted recipe paths. | In CI / pre-commit, or before opening a PR to make sure you didn't forget to run the build. |
| `node --experimental-strip-types scripts/build-manifest.mjs` | Just the manifest build. Doesn't touch `.yml`. | When you want a quick rebuild without sidecar regen. Rare. |
| `node --experimental-strip-types scripts/regen-sidecars.mjs` | Just the sidecar regen. Reads the current `static/recipes.json` and writes any `.yml` that's drifted. Pass `--check` to abort instead of writing. | When you've manually edited a `.yml` and want to revert it to the body-derived form. |
| `npm run dev` | Starts the SvelteKit dev server. | When you want to preview the changes in a browser. Reads `static/recipes.json` — you need to have built it first. |
| `npm run check` | `svelte-check` over the SvelteKit app code. | Before opening a PR. Must be 0/0. |
| `npm run test` | Vitest unit tests. | Before opening a PR. |

### Catching drift before commit

`npm run check:sync` is the gate. Two ways to wire it:

**Pre-commit hook (local guard).** Put this in `recipes-content/.git/hooks/pre-commit` (make it executable: `chmod +x`):

```sh
#!/bin/sh
# Fail commit if any .yml sidecar would drift from its .md body.
# Skips the check when only non-recipe files (README, LICENSE,
# WORKFLOW.md, etc.) changed.
set -e
if git diff --cached --name-only | grep -qE '\.(md|yml)$'; then
  (cd ../recipes-ui-next && npm run --silent check:sync) || {
    echo
    echo "  Sidecar drift detected. Run 'npm run build-manifest' in" >&2
    echo "  recipes-ui-next/, commit the resulting .yml changes," >&2
    echo "  and retry your commit." >&2
    exit 1
  }
fi
```

**CI workflow (PR gate).** A GitHub Actions workflow on `recipes-content` that checks out `recipes-ui-next` as a sibling and runs the check:

```yaml
# .github/workflows/sync-check.yml
name: sidecar-sync
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { path: recipes-content }
      - uses: actions/checkout@v4
        with:
          repository: KelsierLuthadel/recipes-ui-next
          path: recipes-ui-next
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci
        working-directory: recipes-ui-next
      - run: npm run check:sync
        working-directory: recipes-ui-next
```

Either layer catches the "forgot to rebuild after editing the `.md`" mistake. Both is fine; the hook is fast feedback, the CI is the reliable gate.

### What's automatic

- **`.yml` is regenerated.** Every `npm run build-manifest` writes any `.yml` whose body-derived form has changed. You never write `.yml` by hand.
- **Cross-recipe links are detected.** If your recipe's body mentions another recipe by name (or links to its `.md`), the build picks it up and writes the slug into your recipe's `mentions:` array.
- **Allergens / diet tags / protein / category** are all derived from the ingredient block + folder path. Don't add them by hand to either file.
- **Latest / Recently-added / Top-rated** lists are rebuilt every time the manifest is.

### What's NOT automatic

- **Image fetching.** If a recipe needs a hero image you don't have, run `node scripts/fetch-missing-images.mjs` (Pexels API key required). The vanilla repo has this script; if `next` doesn't yet, you can run the vanilla one against the same recipes-content directory.
- **Image thumbnails.** Generated by a separate script in vanilla; not yet ported to next. For now, hand-crop a 400 px thumb to `resources/thumbs/<slug>.jpg`.
- **Festival tags.** Hand-maintained in `festival-tags.json` (slug → list of festival names). The build merges these into `tags:` after the auto-derived ones.

---

## Common gotchas

- **"My change isn't showing up."** Run `npm run build-manifest`. The dev server reads the built `static/recipes.json`; if you skipped the build, the site is stale.
- **"My recipe doesn't have a `gluten-free` tag but I think it should."** Diet tags are derived from regex scans of the Ingredients block. A line like `Gluten-free warning: contains wheat in some asafoetida brands` in the Notes section won't add `gluten-free` — but it also won't cause a false positive (the scan is scoped to the `## Ingredients` block only).
- **"The build says 'missing prep, missing cook' on a tutorial page."** Tutorial pages don't need prep/cook times — the build accepts that and emits them as `null` in the manifest. The migrator's "flagged" log line is informational, not an error.
- **"I edited a `.yml` to fix something and the build wiped it."** The `.yml` is derived. To fix the data, fix the body line that produces it.
- **"Two recipes have the same slug."** The build doesn't deduplicate by slug — last-writer-wins on the manifest. Rename the file before this bites you in cross-references.

---

## Where the data flows

```
                  ┌─────────────────────────────────────┐
                  │  recipes-content/<slug>.md          │
                  │  (source of truth - author edits)   │
                  └────────────────────┬────────────────┘
                                       │
                                       ▼
              ┌──────────────────────────────────────────────┐
              │  scripts/build-manifest.mjs                   │
              │  - extractPrepTime, extractCookTime           │
              │  - deriveAllergens, deriveTags                │
              │  - detectMentions                             │
              │  - extractIngredientText / IngredientNames    │
              └────────────┬──────────────┬───────────────────┘
                           │              │
                           ▼              ▼
            ┌───────────────────────┐  ┌──────────────────────────┐
            │  static/recipes.json  │  │  scripts/regen-sidecars  │
            │  (runtime manifest)   │  │  reads the manifest,     │
            └───────────────────────┘  │  writes per-recipe .yml  │
                                       └─────────────┬────────────┘
                                                     │
                                                     ▼
                              ┌─────────────────────────────────────┐
                              │  recipes-content/<slug>.yml         │
                              │  (derived snapshot - never edited)  │
                              └─────────────────────────────────────┘
```

The `build-manifest` npm script chains both columns: `node build-manifest.mjs && node regen-sidecars.mjs`. After the chain runs, both `static/recipes.json` and every `.yml` file are in lockstep with the `.md` bodies.
