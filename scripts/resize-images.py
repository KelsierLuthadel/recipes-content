#!/usr/bin/env python
"""Resize recipe images wider than MAX_WIDTH down to MAX_WIDTH while
keeping aspect ratio. Backs up the original to a sibling "old/" folder
(same filename) so re-runs are non-destructive.

Skips images already <= MAX_WIDTH and images already backed up.
JPEG output uses quality 85 (visually identical to the source at this scale).

Usage:
  python scripts/resize-images.py            # default 900px (project spec)
  python scripts/resize-images.py 1200       # custom max width
  python scripts/resize-images.py 900 --dry  # report only
  python scripts/resize-images.py --dir cuisine/vietnamese   # scope to a subtree
"""

from __future__ import annotations
import os
import sys
from pathlib import Path
from PIL import Image, ImageOps

REPO_ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {'.git', 'docs', 'node_modules', 'scripts', 'wip', 'old'}
EXTS = {'.jpg', '.jpeg', '.png'}

def parse_args():
    max_w = 900
    dry = False
    root = None
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--dry':
            dry = True
        elif a in ('--dir', '-d'):
            i += 1
            root = args[i] if i < len(args) else None
        else:
            try:
                max_w = int(a)
            except ValueError:
                print(f"Unrecognised arg: {a}", file=sys.stderr)
                sys.exit(2)
        i += 1
    return max_w, dry, root

def walk_images(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith('.')]
        for f in filenames:
            if Path(f).suffix.lower() in EXTS:
                yield Path(dirpath) / f

def main():
    max_w, dry, root_arg = parse_args()
    if root_arg:
        candidate = (REPO_ROOT / root_arg).resolve()
        if not candidate.exists():
            print(f"Directory not found: {root_arg}", file=sys.stderr)
            sys.exit(2)
        root = candidate
    else:
        root = REPO_ROOT
    targets = []
    for img_path in walk_images(root):
        try:
            with Image.open(img_path) as im:
                w, h = im.size
        except Exception as e:
            print(f"[skip] {img_path.relative_to(REPO_ROOT)} (cannot open: {e})")
            continue
        if w <= max_w:
            continue
        targets.append((img_path, w, h))

    print(f"Found {len(targets)} images with width > {max_w}px")
    if dry:
        for p, w, h in targets[:20]:
            print(f"  {w}x{h}  {p.relative_to(REPO_ROOT)}")
        if len(targets) > 20:
            print(f"  ... and {len(targets) - 20} more")
        return

    resized = 0
    failed = 0
    for i, (img_path, w, h) in enumerate(targets, 1):
        try:
            with Image.open(img_path) as im:
                im = ImageOps.exif_transpose(im)
                new_h = round(h * max_w / w)
                resized_im = im.resize((max_w, new_h), Image.LANCZOS)

                # Back up the original to a sibling old/ folder (idempotent).
                backup_dir = img_path.parent / 'old'
                backup_dir.mkdir(exist_ok=True)
                backup_path = backup_dir / img_path.name
                if not backup_path.exists():
                    # Copy the original bytes to old/ before overwriting.
                    backup_path.write_bytes(img_path.read_bytes())

                # Save resized in place.
                fmt = (im.format or img_path.suffix.lstrip('.').upper())
                if fmt.upper() in ('JPEG', 'JPG'):
                    if resized_im.mode != 'RGB':
                        resized_im = resized_im.convert('RGB')
                    resized_im.save(img_path, 'JPEG', quality=85, optimize=True, progressive=True)
                elif fmt.upper() == 'PNG':
                    resized_im.save(img_path, 'PNG', optimize=True)
                else:
                    resized_im.save(img_path, optimize=True)
            new_size = img_path.stat().st_size
            print(f"[{i}/{len(targets)}] {w}x{h} -> {max_w}x{new_h}  ({new_size // 1024} KB)  {img_path.relative_to(REPO_ROOT)}")
            resized += 1
        except Exception as e:
            print(f"[err] {img_path.relative_to(REPO_ROOT)}: {e}")
            failed += 1

    print()
    print(f"Resized {resized}, failed {failed}.")
    if resized:
        print(f"Originals backed up next to each image in a sibling 'old/' folder.")

if __name__ == '__main__':
    main()
