"""
Find images with a distinctly portrait aspect ratio (height/width > 1.25)
under the recipe tree and re-save each so git status lists them as
modified - the user wants to step through them and decide which to
replace with landscape alternatives.

Walks every directory except node_modules/, .git/, TODO/, and
resources/thumbs/ (thumbs are regenerated from the originals; fix the
original first). For each main image whose height exceeds width by 25 %
or more, the image is re-loaded with Pillow and saved back over itself
using quality='keep' for JPEGs so the encode is byte-perfect-or-close at
the original quality level. The save produces enough byte-level change
for git to register a modification, without any visible quality drift.

Usage:
    python scripts/touch-portrait-images.py            # touch and report
    python scripts/touch-portrait-images.py --dry-run  # report only
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent

SKIP_DIRS = {"node_modules", ".git", "TODO", "thumbs"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

# A recipe image counts as "distinctly portrait" when its height exceeds
# its width by 25 % or more. Anything between 0.95 and 1.25 reads as
# near-square and isn't worth re-shooting; below 0.95 is landscape (the
# format the card grid is designed around) so it's left alone.
PORTRAIT_RATIO = 1.25


def iter_images(root: Path):
    """Yield every image path under `root`, skipping SKIP_DIRS."""
    for dirpath, dirnames, filenames in os.walk(root):
        # Mutating dirnames in-place prunes the walk.
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            ext = Path(name).suffix.lower()
            if ext in IMAGE_EXTS:
                yield Path(dirpath) / name


def is_portrait(img_path: Path):
    """Return (is_portrait, width, height) or (False, 0, 0) on failure."""
    try:
        with Image.open(img_path) as im:
            w, h = im.size
    except Exception:
        return False, 0, 0
    if w <= 0:
        return False, w, h
    return (h / w) >= PORTRAIT_RATIO, w, h


def touch_image(img_path: Path):
    """Re-encode the image in place to bump its content hash for git.
    Returns True on success, False if Pillow refused the file."""
    try:
        with Image.open(img_path) as im:
            im.load()  # decode pixels before we close the file handle
            fmt = im.format
            info = im.info
        ext = img_path.suffix.lower()
        save_kwargs = {}
        if ext in (".jpg", ".jpeg") or fmt == "JPEG":
            # quality='keep' tells Pillow to reuse the original encode
            # quantisation tables - no visible quality drift.
            save_kwargs["quality"] = "keep"
            if "exif" in info:
                save_kwargs["exif"] = info["exif"]
            if "icc_profile" in info:
                save_kwargs["icc_profile"] = info["icc_profile"]
        # PNG / WebP re-saves are lossless by default so no extra config.
        with Image.open(img_path) as im:
            im.save(img_path, format=fmt, **save_kwargs)
        return True
    except Exception as e:
        print(f"  ! could not re-save {img_path}: {e}", file=sys.stderr)
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="List portrait images without re-saving them.",
    )
    args = ap.parse_args()

    portrait_count = 0
    touched_count = 0
    scanned = 0
    portrait_paths = []

    for img_path in iter_images(REPO_ROOT):
        scanned += 1
        portrait, w, h = is_portrait(img_path)
        if not portrait:
            continue
        portrait_count += 1
        rel = img_path.relative_to(REPO_ROOT).as_posix()
        ratio = h / w if w else 0
        print(f"  {rel}  ({w}x{h}, h/w={ratio:.2f})")
        portrait_paths.append(rel)
        if not args.dry_run:
            if touch_image(img_path):
                touched_count += 1

    print()
    print(f"Scanned {scanned} images, found {portrait_count} portrait (h/w >= {PORTRAIT_RATIO}).")
    if not args.dry_run:
        print(f"Re-saved {touched_count} of them - check `git status`.")


if __name__ == "__main__":
    main()
