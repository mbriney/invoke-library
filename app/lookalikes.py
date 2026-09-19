from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from app.config import Settings
from app.images import IMAGE_EXTS, ImageKind, classify_image, classify_from_dto, classify_from_path, image_name_from_path
from app.paths import ensure_dir, safe_relpath

logger = logging.getLogger(__name__)

CACHE_VERSION = 2
HASH_SIZE = 8  # 64-bit average / difference hash
_CACHE_LOCK = threading.Lock()

# Background lookalike scan job (process-wide)
_job_lock = threading.Lock()
_scanning = False
_progress: dict[str, Any] = {"done": 0, "total": 0, "phase": "idle"}
_last_payload: dict[str, Any] | None = None
_last_items: list[HashedImage] | None = None  # type: ignore[name-defined]
_last_error: str | None = None
_last_finished_at: float | None = None
_last_hash_stats: dict[str, int] | None = None


@dataclass
class HashedImage:
    path: Path
    rel: str
    image_name: str
    kind: ImageKind
    kind_source: str
    mtime: float
    size: int
    phash: int  # aHash
    dhash: int = 0  # dHash (0 is a valid hash for flat images)


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


def difference_hash(path: Path, hash_size: int = HASH_SIZE) -> int:
    """64-bit difference hash (dHash): compare adjacent pixels on hash_size+1 width."""
    with Image.open(path) as im:
        gray = im.convert("L")
        small = gray.resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
        pixels = list(small.getdata())
    bits = 0
    bit = 0
    for row in range(hash_size):
        row_off = row * (hash_size + 1)
        for col in range(hash_size):
            left = pixels[row_off + col]
            right = pixels[row_off + col + 1]
            if left < right:
                bits |= 1 << bit
            bit += 1
    return bits


def hamming_distance(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def perceptual_distance(a: HashedImage, b: HashedImage) -> int:
    """Min Hamming across aHash and dHash (dHash 0 is a valid hash for flat images)."""
    return min(
        hamming_distance(a.phash, b.phash),
        hamming_distance(a.dhash, b.dhash),
    )


def _load_cache(settings: Settings) -> dict[str, Any]:
    path = _cache_path(settings)
    if not path.is_file():
        return {"version": CACHE_VERSION, "entries": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Corrupt phash cache at %s; rebuilding", path)
        return {"version": CACHE_VERSION, "entries": {}}
    if not isinstance(data, dict):
        return {"version": CACHE_VERSION, "entries": {}}
    # Accept v1 (ahash only) and v2 (ahash+dhash); migrate on write.
    ver = data.get("version")
    if ver not in (1, CACHE_VERSION):
        return {"version": CACHE_VERSION, "entries": {}}
    entries = data.get("entries")
    if not isinstance(entries, dict):
        entries = {}
    return {"version": int(ver), "entries": entries}


def _save_cache(settings: Settings, cache: dict[str, Any]) -> None:
    ensure_dir(settings.config_dir)
    path = _cache_path(settings)
    tmp = path.with_suffix(".tmp")
    cache = {**cache, "version": CACHE_VERSION}
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
    progress_cb: Callable[[int, int], None] | None = None,
) -> tuple[list[HashedImage], dict[str, int]]:
    """Scan outputs, classify, compute/cached aHash+dHash. Returns items + cache stats."""
    root = settings.invoke_outputs_dir
    files = _scan_image_files(settings)
    total_files = len(files)
    if progress_cb:
        progress_cb(0, total_files)

    with _CACHE_LOCK:
        cache = _load_cache(settings)
        entries: dict[str, Any] = dict(cache.get("entries") or {})
        live_keys: set[str] = set()
        hashed: list[HashedImage] = []
        stats = {"total": 0, "cache_hits": 0, "computed": 0, "errors": 0}

        for idx, p in enumerate(files):
            try:
                st = p.stat()
            except OSError:
                stats["errors"] += 1
                if progress_cb:
                    progress_cb(idx + 1, total_files)
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
            dhash: int | None = None
            if (
                isinstance(cached, dict)
                and cached.get("mtime") == st.st_mtime
                and isinstance(cached.get("hash"), str)
            ):
                try:
                    phash = int(cached["hash"], 16)
                    dhash_raw = cached.get("dhash")
                    if isinstance(dhash_raw, str):
                        dhash = int(dhash_raw, 16)
                    stats["cache_hits"] += 1
                except ValueError:
                    phash = None
                    dhash = None

            if phash is None or dhash is None:
                try:
                    if phash is None:
                        phash = average_hash(p)
                    if dhash is None:
                        dhash = difference_hash(p)
                    stats["computed"] += 1
                    entries[rel] = {
                        "mtime": st.st_mtime,
                        "hash": f"{phash:016x}",
                        "dhash": f"{dhash:016x}",
                    }
                except Exception:
                    logger.debug("phash failed for %s", rel, exc_info=True)
                    stats["errors"] += 1
                    if progress_cb:
                        progress_cb(idx + 1, total_files)
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
                    dhash=dhash or 0,
                )
            )
            if progress_cb:
                progress_cb(idx + 1, total_files)

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
    hamming: int = 14,
) -> list[list[HashedImage]]:
    """Union-find groups where pairwise perceptual distance ≤ threshold."""
    n = len(items)
    if n < 2:
        return []
    uf = _UnionFind(n)
    # Bucket by high bits to cut comparisons; still check nearby buckets for threshold.
    # For 64-bit hashes and small libraries, full pairwise is fine up to a few thousand.
    if n <= 2500:
        for i in range(n):
            for j in range(i + 1, n):
                if perceptual_distance(items[i], items[j]) <= hamming:
                    uf.union(i, j)
    else:
        # Prefix buckets (top 16 bits of aHash) + neighbor scan for large libs
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
                    if perceptual_distance(items[i], items[j]) <= hamming:
                        uf.union(i, j)

    clusters: dict[int, list[HashedImage]] = {}
    for i, it in enumerate(items):
        root = uf.find(i)
        clusters.setdefault(root, []).append(it)

    groups = [g for g in clusters.values() if len(g) >= 2]
    for g in groups:
        g.sort(key=lambda x: x.mtime, reverse=True)

    def sort_key(g: list[HashedImage]) -> tuple:
        kinds = {x.kind for x in g}
        mixed = 0 if ("input" in kinds and "output" in kinds) else 1
        newest = max(x.mtime for x in g)
        return (mixed, -len(g), -newest)

    groups.sort(key=sort_key)
    return groups


def _groups_to_payload(
    groups_raw: list[list[HashedImage]],
    *,
    threshold: int,
    hash_stats: dict[str, int],
    mixed_only: bool,
) -> dict[str, Any]:
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
                        "dhash": f"{x.dhash:016x}",
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
            "singleton_skipped": hash_stats.get("total", 0) - sum(len(g) for g in groups_raw),
        },
    }


def lookalike_payload(
    settings: Settings,
    *,
    dto_by_name: dict[str, dict[str, Any]] | None = None,
    hamming: int | None = None,
    mixed_only: bool = False,
    progress_cb: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Synchronous full scan + group (CPU-heavy). Prefer the background job APIs."""
    threshold = settings.lookalike_hamming if hamming is None else max(0, min(int(hamming), 32))
    items, hash_stats = collect_hashed_images(
        settings, dto_by_name=dto_by_name, progress_cb=progress_cb
    )
    groups_raw = group_lookalikes(items, hamming=threshold)
    return _groups_to_payload(groups_raw, threshold=threshold, hash_stats=hash_stats, mixed_only=mixed_only)


def _set_progress(done: int, total: int, phase: str) -> None:
    global _progress
    with _job_lock:
        _progress = {"done": int(done), "total": int(total), "phase": phase}


def _run_lookalike_scan(
    settings: Settings,
    *,
    hamming: int,
    mixed_only: bool,
    dto_by_name: dict[str, dict[str, Any]] | None,
) -> None:
    global _scanning, _progress, _last_payload, _last_items, _last_error, _last_finished_at, _last_hash_stats
    try:
        _set_progress(0, 0, "hashing")

        def on_hash_progress(done: int, total: int) -> None:
            _set_progress(done, total, "hashing")

        items, hash_stats = collect_hashed_images(
            settings, dto_by_name=dto_by_name, progress_cb=on_hash_progress
        )
        _set_progress(hash_stats.get("total", 0), hash_stats.get("total", 0), "grouping")
        groups_raw = group_lookalikes(items, hamming=hamming)
        payload = _groups_to_payload(
            groups_raw, threshold=hamming, hash_stats=hash_stats, mixed_only=mixed_only
        )
        with _job_lock:
            _last_items = items
            _last_hash_stats = hash_stats
            _last_payload = payload
            _last_error = None
            _last_finished_at = time.time()
    except Exception as exc:
        logger.exception("Lookalike scan failed")
        with _job_lock:
            _last_error = str(exc) or exc.__class__.__name__
            _last_finished_at = time.time()
    finally:
        with _job_lock:
            _scanning = False
            done = _progress.get("done") or 0
            total = _progress.get("total") or 0
            _progress = {"done": done, "total": total, "phase": "done"}


def start_lookalike_scan(
    settings: Settings,
    *,
    hamming: int | None = None,
    mixed_only: bool = False,
    dto_by_name: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Start a background scan if one is not already running. Returns job status."""
    global _scanning, _progress, _last_error
    threshold = settings.lookalike_hamming if hamming is None else max(0, min(int(hamming), 32))
    with _job_lock:
        if _scanning:
            return {
                "ok": True,
                "started": False,
                "already_running": True,
                "scanning": True,
                "progress": dict(_progress),
                "hamming": threshold,
            }
        _scanning = True
        _progress = {"done": 0, "total": 0, "phase": "starting"}
        _last_error = None

    thread = threading.Thread(
        target=_run_lookalike_scan,
        kwargs={
            "settings": settings,
            "hamming": threshold,
            "mixed_only": mixed_only,
            "dto_by_name": dto_by_name,
        },
        name="lookalike-scan",
        daemon=True,
    )
    thread.start()
    return {
        "ok": True,
        "started": True,
        "already_running": False,
        "scanning": True,
        "progress": {"done": 0, "total": 0, "phase": "starting"},
        "hamming": threshold,
    }


def get_lookalike_snapshot(
    settings: Settings,
    *,
    hamming: int | None = None,
    mixed_only: bool = False,
) -> dict[str, Any]:
    """Non-blocking: last completed groups + scanning/progress. Regroups from memory if hamming changes."""
    threshold = settings.lookalike_hamming if hamming is None else max(0, min(int(hamming), 32))

    with _job_lock:
        scanning = _scanning
        progress = dict(_progress)
        error = _last_error
        finished_at = _last_finished_at
        items = _last_items
        hash_stats = dict(_last_hash_stats) if _last_hash_stats else {"total": 0, "cache_hits": 0, "computed": 0, "errors": 0}
        cached_payload = _last_payload

    if items is not None:
        # Fast regroup for Hamming / mixed_only changes without rehashing
        groups_raw = group_lookalikes(items, hamming=threshold)
        payload = _groups_to_payload(
            groups_raw, threshold=threshold, hash_stats=hash_stats, mixed_only=mixed_only
        )
    elif cached_payload is not None and cached_payload.get("hamming") == threshold:
        payload = {
            "hamming": threshold,
            "groups": list(cached_payload.get("groups") or []),
            "stats": dict(cached_payload.get("stats") or {}),
        }
        if mixed_only:
            payload["groups"] = [g for g in payload["groups"] if g.get("mixed")]
            payload["stats"] = {
                **payload["stats"],
                "groups": len(payload["groups"]),
                "mixed_groups": len(payload["groups"]),
            }
    else:
        payload = {
            "hamming": threshold,
            "groups": [],
            "stats": {**hash_stats, "groups": 0, "mixed_groups": 0, "singleton_skipped": 0},
        }

    return {
        **payload,
        "scanning": scanning,
        "progress": progress,
        "completed_at": finished_at,
        "error": error,
        "has_result": items is not None or cached_payload is not None,
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
