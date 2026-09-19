from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from app.config import Settings
from app.images import IMAGE_EXTS, ImageKind, classify_image, classify_from_dto, classify_from_path, image_name_from_path
from app.paths import ensure_dir, safe_relpath

logger = logging.getLogger(__name__)

CACHE_VERSION = 1
HASH_SIZE = 8  # 64-bit average hash
_CACHE_LOCK = threading.Lock()


@dataclass
class HashedImage:
    path: Path
    rel: str
    image_name: str
    kind: ImageKind
    kind_source: str
    mtime: float
    size: int
    phash: int


def _cache_path(settings: Settings) -> Path:
    return settings.config_dir / "phash-cache.json"


def average_hash(path: Path, hash_size: int = HASH_SIZE) -> int:
    """64-bit average hash (aHash) via Pillow — no extra deps."""
    with Image.open(path) as im:
        gray = im.convert("L")
        small = gray.resize((hash_size, hash_size), Image.Resampling.LANCZOS)
        pixels = list(small.getdata())
    avg = sum(pixels) / len(pixels) if pixels else 0.0
    bits = 0
    for i, p in enumerate(pixels):
        if p >= avg:
            bits |= 1 << i
    return bits


def hamming_distance(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def _load_cache(settings: Settings) -> dict[str, Any]:
    path = _cache_path(settings)
    if not path.is_file():
        return {"version": CACHE_VERSION, "entries": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Corrupt phash cache at %s; rebuilding", path)
        return {"version": CACHE_VERSION, "entries": {}}
    if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
        return {"version": CACHE_VERSION, "entries": {}}
    entries = data.get("entries")
    if not isinstance(entries, dict):
        entries = {}
    return {"version": CACHE_VERSION, "entries": entries}


def _save_cache(settings: Settings, cache: dict[str, Any]) -> None:
    ensure_dir(settings.config_dir)
    path = _cache_path(settings)
    tmp = path.with_suffix(".tmp")
    payload = json.dumps(cache, separators=(",", ":"))
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def _scan_image_files(settings: Settings) -> list[Path]:
    root = settings.invoke_outputs_dir
    if not root.exists():
        return []
    scan_roots: list[Path] = []
    sub = (settings.image_subdir or "").strip().strip("/")
    if sub:
        images_subdir = root / sub
        scan_roots.append(images_subdir if images_subdir.is_dir() else root)
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
    return files


def collect_hashed_images(
    settings: Settings,
    *,
    dto_by_name: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[HashedImage], dict[str, int]]:
    """Scan outputs, classify, compute/cached aHash. Returns items + cache stats."""
    root = settings.invoke_outputs_dir
    files = _scan_image_files(settings)
    with _CACHE_LOCK:
        cache = _load_cache(settings)
        entries: dict[str, Any] = dict(cache.get("entries") or {})
        live_keys: set[str] = set()
        hashed: list[HashedImage] = []
        stats = {"total": 0, "cache_hits": 0, "computed": 0, "errors": 0}

        for p in files:
            try:
                st = p.stat()
            except OSError:
                stats["errors"] += 1
                continue
            rel = safe_relpath(p, root)
            live_keys.add(rel)
            stats["total"] += 1
            name = image_name_from_path(p)
            dto = (dto_by_name or {}).get(name)
            need_meta = classify_from_dto(dto) is None and classify_from_path(rel) is None
            kind, src = classify_image(p, rel, dto=dto, peek_metadata=need_meta)

            cached = entries.get(rel)
            phash: int | None = None
            if (
                isinstance(cached, dict)
                and cached.get("mtime") == st.st_mtime
                and isinstance(cached.get("hash"), str)
            ):
                try:
                    phash = int(cached["hash"], 16)
                    stats["cache_hits"] += 1
                except ValueError:
                    phash = None

            if phash is None:
                try:
                    phash = average_hash(p)
                    stats["computed"] += 1
                    entries[rel] = {"mtime": st.st_mtime, "hash": f"{phash:016x}"}
                except Exception:
                    logger.debug("phash failed for %s", rel, exc_info=True)
                    stats["errors"] += 1
                    continue

            hashed.append(
                HashedImage(
                    path=p,
                    rel=rel,
                    image_name=name,
                    kind=kind,
                    kind_source=src,
                    mtime=st.st_mtime,
                    size=st.st_size,
                    phash=phash,
                )
            )

        # Drop stale cache keys for deleted files (keep cache bounded)
        stale = [k for k in entries if k not in live_keys]
        for k in stale:
            entries.pop(k, None)
        cache["entries"] = entries
        cache["updated_at"] = time.time()
        try:
            _save_cache(settings, cache)
        except Exception:
            logger.warning("Failed to write phash cache", exc_info=True)

    return hashed, stats


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            self.parent[ra] = rb
        elif self.rank[ra] > self.rank[rb]:
            self.parent[rb] = ra
        else:
            self.parent[rb] = ra
            self.rank[ra] += 1


def group_lookalikes(
    items: list[HashedImage],
    *,
    hamming: int = 8,
) -> list[list[HashedImage]]:
    """Union-find groups where pairwise Hamming distance ≤ threshold."""
    n = len(items)
    if n < 2:
        return []
    uf = _UnionFind(n)
    # Bucket by high bits to cut comparisons; still check nearby buckets for threshold.
    # For 64-bit hashes and small libraries, full pairwise is fine up to a few thousand.
    if n <= 2500:
        for i in range(n):
            hi = items[i].phash
            for j in range(i + 1, n):
                if hamming_distance(hi, items[j].phash) <= hamming:
                    uf.union(i, j)
    else:
        # Prefix buckets (top 16 bits) + neighbor scan for large libs
        buckets: dict[int, list[int]] = {}
        for i, it in enumerate(items):
            key = it.phash >> 48
            buckets.setdefault(key, []).append(i)
        checked: set[tuple[int, int]] = set()
        for key, idxs in buckets.items():
            candidates = list(idxs)
            for delta in (-1, 1):
                candidates.extend(buckets.get(key + delta, []))
            for a in range(len(candidates)):
                i = candidates[a]
                for b in range(a + 1, len(candidates)):
                    j = candidates[b]
                    pair = (i, j) if i < j else (j, i)
                    if pair in checked:
                        continue
                    checked.add(pair)
                    if hamming_distance(items[i].phash, items[j].phash) <= hamming:
                        uf.union(i, j)

    clusters: dict[int, list[HashedImage]] = {}
    for i, it in enumerate(items):
        root = uf.find(i)
        clusters.setdefault(root, []).append(it)

    groups = [g for g in clusters.values() if len(g) >= 2]
    for g in groups:
        g.sort(key=lambda x: x.mtime, reverse=True)
    # Mixed input+output first, then larger groups, then newest mtime in group
    def sort_key(g: list[HashedImage]) -> tuple:
        kinds = {x.kind for x in g}
        mixed = 0 if ("input" in kinds and "output" in kinds) else 1
        newest = max(x.mtime for x in g)
        return (mixed, -len(g), -newest)

    groups.sort(key=sort_key)
    return groups


def lookalike_payload(
    settings: Settings,
    *,
    dto_by_name: dict[str, dict[str, Any]] | None = None,
    hamming: int | None = None,
    mixed_only: bool = False,
) -> dict[str, Any]:
    threshold = settings.lookalike_hamming if hamming is None else max(0, min(int(hamming), 32))
    items, hash_stats = collect_hashed_images(settings, dto_by_name=dto_by_name)
    groups_raw = group_lookalikes(items, hamming=threshold)

    groups_out: list[dict[str, Any]] = []
    mixed_count = 0
    for idx, g in enumerate(groups_raw):
        kinds = {x.kind for x in g}
        mixed = "input" in kinds and "output" in kinds
        if mixed:
            mixed_count += 1
        if mixed_only and not mixed:
            continue
        groups_out.append(
            {
                "id": f"g{idx}",
                "mixed": mixed,
                "size": len(g),
                "kinds": sorted(kinds),
                "items": [
                    {
                        "path": x.rel,
                        "image_name": x.image_name,
                        "kind": x.kind,
                        "kind_source": x.kind_source,
                        "mtime": x.mtime,
                        "size": x.size,
                        "phash": f"{x.phash:016x}",
                    }
                    for x in g
                ],
            }
        )

    return {
        "hamming": threshold,
        "groups": groups_out,
        "stats": {
            **hash_stats,
            "groups": len(groups_out),
            "mixed_groups": mixed_count if not mixed_only else sum(1 for g in groups_out if g["mixed"]),
            "singleton_skipped": hash_stats["total"] - sum(len(g) for g in groups_raw),
        },
    }


def list_input_refs(
    settings: Settings,
    *,
    dto_by_name: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """All images classified as input (same rules as Inputs filter), unpaginated."""
    from app.images import list_images

    # Reuse list_images with a high page size by looping pages
    page = 1
    limit = 200
    paths: list[dict[str, str]] = []
    counts = {"all": 0, "output": 0, "input": 0, "unknown": 0}
    while True:
        data = list_images(settings, page=page, limit=limit, kind="input", dto_by_name=dto_by_name)
        if page == 1 and data.get("counts"):
            counts = data["counts"]
        for it in data.get("items") or []:
            paths.append({"path": it["path"], "image_name": it.get("image_name") or Path(it["path"]).name})
        pages = int(data.get("pages") or 0)
        if page >= pages or not data.get("items"):
            break
        page += 1
    return {"kind": "input", "count": len(paths), "items": paths, "counts": counts}
