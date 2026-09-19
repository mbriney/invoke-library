from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from PIL import Image

from app.config import Settings
from app.paths import ensure_dir, resolve_under, safe_relpath

logger = logging.getLogger(__name__)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def image_name_from_path(path: Path) -> str:
    """Invoke gallery files are typically UUID.ext; basename is the image_name."""
    return path.name


def list_images(settings: Settings, page: int = 1, limit: int = 48) -> dict:
    root = settings.invoke_outputs_dir
    if not root.exists():
        return {"items": [], "total": 0, "page": page, "limit": limit, "pages": 0}

    scan_roots: list[Path] = []
    sub = (settings.image_subdir or "").strip().strip("/")
    if sub:
        images_subdir = root / sub
        if images_subdir.is_dir():
            scan_roots.append(images_subdir)
        else:
            scan_roots.append(root)
    else:
        scan_roots.append(root)

    files: list[Path] = []
    for scan in scan_roots:
        for p in scan.rglob("*"):
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
                parts_lower = {part.lower() for part in p.parts}
                if "thumbnails" in parts_lower:
                    continue
                files.append(p)

    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    total = len(files)
    page = max(1, page)
    limit = max(1, min(limit, 200))
    start = (page - 1) * limit
    end = start + limit
    slice_ = files[start:end]

    items = []
    for p in slice_:
        st = p.stat()
        rel = safe_relpath(p, root)
        items.append(
            {
                "id": rel,
                "path": rel,
                "mtime": st.st_mtime,
                "size": st.st_size,
                "image_name": image_name_from_path(p),
            }
        )

    pages = (total + limit - 1) // limit if total else 0
    return {"items": items, "total": total, "page": page, "limit": limit, "pages": pages}


def resolve_output_image(settings: Settings, rel_path: str) -> Path:
    return resolve_under(settings.invoke_outputs_dir, rel_path)


def thumb_cache_path(settings: Settings, rel_path: str, mtime: float) -> Path:
    key = hashlib.sha256(f"{rel_path}:{mtime}".encode()).hexdigest()[:40]
    return settings.thumb_cache_dir / f"{key}.jpg"


def get_or_make_thumb(settings: Settings, rel_path: str) -> Path:
    src = resolve_output_image(settings, rel_path)
    if not src.is_file():
        raise FileNotFoundError(rel_path)
    mtime = src.stat().st_mtime
    cache = thumb_cache_path(settings, rel_path, mtime)
    if cache.is_file():
        return cache

    ensure_dir(settings.thumb_cache_dir)
    with Image.open(src) as im:
        im = im.convert("RGB") if im.mode not in ("RGB", "L") else im.convert("RGB")
        im.thumbnail((settings.thumb_max_size, settings.thumb_max_size), Image.Resampling.LANCZOS)
        im.save(cache, "JPEG", quality=settings.thumb_quality, optimize=True)
    return cache
