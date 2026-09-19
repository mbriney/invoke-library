from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Literal

from PIL import Image

from app.config import Settings
from app.paths import ensure_dir, resolve_under, safe_relpath

logger = logging.getLogger(__name__)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

ImageKind = Literal["output", "input", "unknown"]

# Invoke ImageCategory values that behave as assets / uploads
_INPUT_PATH_MARKERS = frozenset({"user", "control", "mask", "other", "uploads", "upload", "init", "inputs"})
_OUTPUT_PATH_MARKERS = frozenset({"general", "outputs", "output", "generated"})


def image_name_from_path(path: Path) -> str:
    """Invoke gallery files are typically UUID.ext; basename is the image_name."""
    return path.name


def classify_from_path(rel: str) -> ImageKind | None:
    """Infer kind from relative path segments (image_subfolder_strategy=type, etc.)."""
    parts = [p.lower() for p in Path(rel).parts]
    # Prefer more specific asset markers over "general"
    for p in parts:
        if p in _INPUT_PATH_MARKERS:
            return "input"
    for p in parts:
        if p in _OUTPUT_PATH_MARKERS:
            return "output"
    return None


def classify_from_dto(dto: dict[str, Any] | None) -> ImageKind | None:
    """Authoritative classification from Invoke ImageDTO fields."""
    if not dto or not isinstance(dto, dict):
        return None
    origin = str(dto.get("image_origin") or "").strip().lower()
    category = str(dto.get("image_category") or "").strip().lower()

    if origin == "external" or category in ("user", "control", "mask", "other"):
        return "input"
    if category == "general" or origin == "internal":
        return "output"
    return None


def classify_from_png_metadata(path: Path) -> ImageKind | None:
    """Peek PNG/JPEG text metadata for generation vs upload signals."""
    try:
        with Image.open(path) as im:
            info = dict(im.info or {})
    except Exception:
        return None

    # Strong output signals: Invoke generation metadata / workflow
    for key in ("invokeai_metadata", "invokeai_graph", "invokeai_workflow", "sd-metadata", "parameters"):
        val = info.get(key)
        if not val:
            continue
        if key == "invokeai_metadata":
            try:
                meta = json.loads(val) if isinstance(val, str) else val
            except Exception:
                meta = None
            if isinstance(meta, dict):
                # Generation payloads usually include positive_prompt / model / seed
                if any(k in meta for k in ("positive_prompt", "positive_style_prompt", "model", "seed", "cfg_scale")):
                    return "output"
                # Empty metadata object is inconclusive
                continue
        return "output"

    # Dream / A1111 style parameter strings
    if any(k in info for k in ("Dream", "prompt", "Comment")):
        return "output"

    return None


def classify_image(
    path: Path,
    rel: str,
    *,
    dto: dict[str, Any] | None = None,
    peek_metadata: bool = True,
) -> tuple[ImageKind, str]:
    """
    Return (kind, source) using best available signal.
    source is one of: invoke_api | path | metadata | unknown
    """
    from_api = classify_from_dto(dto)
    if from_api:
        return from_api, "invoke_api"

    from_path = classify_from_path(rel)
    if from_path:
        return from_path, "path"

    if peek_metadata:
        from_meta = classify_from_png_metadata(path)
        if from_meta:
            return from_meta, "metadata"

    return "unknown", "unknown"


def list_images(
    settings: Settings,
    page: int = 1,
    limit: int = 48,
    kind: str | None = None,
    dto_by_name: dict[str, dict[str, Any]] | None = None,
) -> dict:
    root = settings.invoke_outputs_dir
    if not root.exists():
        return {
            "items": [],
            "total": 0,
            "page": page,
            "limit": limit,
            "pages": 0,
            "kind_filter": kind or "all",
            "counts": {"all": 0, "output": 0, "input": 0, "unknown": 0},
        }

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

    # Classify all (path first; metadata only when path unknown — still needed for filters)
    classified: list[tuple[Path, str, ImageKind, str]] = []
    counts = {"all": 0, "output": 0, "input": 0, "unknown": 0}
    for p in files:
        rel = safe_relpath(p, root)
        name = image_name_from_path(p)
        dto = (dto_by_name or {}).get(name)
        # Peek metadata only when path/API didn't decide — keeps listing snappy on large libs
        need_meta = classify_from_dto(dto) is None and classify_from_path(rel) is None
        k, src = classify_image(p, rel, dto=dto, peek_metadata=need_meta)
        classified.append((p, rel, k, src))
        counts["all"] += 1
        counts[k] = counts.get(k, 0) + 1

    kind_norm = (kind or "all").strip().lower()
    if kind_norm in ("output", "input", "unknown"):
        classified = [c for c in classified if c[2] == kind_norm]

    total = len(classified)
    page = max(1, page)
    limit = max(1, min(limit, 200))
    start = (page - 1) * limit
    end = start + limit
    slice_ = classified[start:end]

    items = []
    for p, rel, k, src in slice_:
        st = p.stat()
        items.append(
            {
                "id": rel,
                "path": rel,
                "mtime": st.st_mtime,
                "size": st.st_size,
                "image_name": image_name_from_path(p),
                "kind": k,
                "kind_source": src,
            }
        )

    pages = (total + limit - 1) // limit if total else 0
    return {
        "items": items,
        "total": total,
        "page": page,
        "limit": limit,
        "pages": pages,
        "kind_filter": kind_norm if kind_norm in ("output", "input", "unknown", "all") else "all",
        "counts": counts,
    }


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
