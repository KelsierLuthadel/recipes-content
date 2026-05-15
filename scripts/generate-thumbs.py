#!/usr/bin/env python
"""Generate 400px-wide thumbnails for every recipe image into a sibling
'thumbs/' folder next to each 'resources/' folder.

For each image at <dir>/resources/<name.ext>, writes a JPEG thumbnail at
<dir>/resources/thumbs/<name>.jpg (always JPEG; PNG sources are converted
because card-display doesn't need transparency).

Skips when the thumb already exists AND is newer than the source image,
so re-runs are cheap.

Usage:
  python scripts/generate-thumbs.py            # default 400px wide
  python scripts/generate-thumbs.py 500        # custom max width
  python scripts/generate-thumbs.py --force    # rebuild all thumbs
"""

from __future__ import annotations
import os
import sys
from pathlib import Path
from PIL import Image, ImageOps

REPO_ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {'.git', 'docs', 'node_modules', 'scripts', 'wip', 'thumbs'}
EXTS = {'.jpg', '.jpeg', '.png'}

def parse_args():
    max_w = 400
    force = False
    for a in sys.argv[1:]:
        if a == '--force':
            force = True
        else:
            try:
                max_w = int(a)
            except ValueError:
                print(f"Unrecognised arg: {a}", file=sys.stderr)
                sys.exit(2)
    return max_w, force

def walk_resources(root: Path):
    """Yield (image_path, thumb_path) pairs for every image under any
    'resources/' folder (but not under 'thumbs/' itself)."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith('.')]
        dp = Path(dirpath)
        # Only operate on the immediate contents of a 'resources' folder,
        # not nested deeper (we don't want to thumb our own thumbs).
        if dp.name != 'resources':
            continue
        for f in filenames:
            ext = Path(f).suffix.lower()
            if ext not in EXTS:
                continue
            img_path = dp / f
            # Thumbnail always ends with .jpg regardless of source format.
            thumb_path = dp / 'thumbs' / (Path(f).stem + '.jpg')
            yield img_path, thumb_path

def main():
    max_w, force = parse_args()
    pairs = list(walk_resources(REPO_ROOT))

    print(f"Scanning {len(pairs)} images. Thumb width: {max_w}px.")

    made = 0
    skipped = 0
    failed = 0

    for i, (src, thumb) in enumerate(pairs, 1):
        # Skip if up-to-date.
        if (not force) and thumb.exists() and thumb.stat().st_mtime >= src.stat().st_mtime:
            skipped += 1
            continue
        try:
            with Image.open(src) as im:
                im = ImageOps.exif_transpose(im)
                w, h = im.size
                # If the source is already smaller than the thumb width,
                # we still emit a JPEG thumb at the source size for
                # consistency (so cards always have a thumb URL to load).
                if w > max_w:
                    new_h = round(h * max_w / w)
                    out = im.resize((max_w, new_h), Image.LANCZOS)
                else:
                    out = im.copy()
                if out.mode != 'RGB':
                    out = out.convert('RGB')
                thumb.parent.mkdir(parents=True, exist_ok=True)
                out.save(thumb, 'JPEG', quality=80, optimize=True, progressive=True)
            made += 1
            size_kb = thumb.stat().st_size // 1024
            if made % 50 == 0 or made == 1:
                print(f"  [{i}/{len(pairs)}] {size_kb}KB  {thumb.relative_to(REPO_ROOT)}")
        except Exception as e:
            failed += 1
            print(f"  [err] {src.relative_to(REPO_ROOT)}: {e}")

    print()
    print(f"Created/updated: {made}, up-to-date: {skipped}, failed: {failed}.")

if __name__ == '__main__':
    main()
