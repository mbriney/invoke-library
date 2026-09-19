"""Server-side cache for recursive KEEP_DIR folder listings."""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable

from app.paths import ensure_dir, safe_relpath

logger = logging.getLogger(__name__)

# In-memory TTL for the recursive listing (seconds). Disk cache may outlive
# process restarts; freshness is gated by TTL and KEEP_DIR root mtime.
DEFAULT_TTL_SEC = 120.0
CACHE_FILENAME = "folders-cache.json"

_lock = threading.Lock()
_mem: dict[str, Any] | None = None  # {folders, root, max_depth, listed_at, root_mtime}


def cache_path(config_dir: Path) -> Path:
    return Path(config_dir) / CACHE_FILENAME


def _root_mtime(root: Path) -> float | None:
    try:
        return root.resolve().stat().st_mtime
    except OSError:
        return None


def list_keeper_subdirs(root: Path, *, max_depth: int = 4) -> list[str]:
    """Return relative posix paths of all subdirs under *root*, up to *max_depth*."""
    root_real = root.resolve()
    found: list[str] = []

    def walk(current: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for p in entries:
            if not p.is_dir() or p.name.startswith("."):
                continue
            try:
                rel = safe_relpath(p, root_real)
            except ValueError:
                continue
            parts = Path(rel).parts
            if len(parts) > max_depth:
                continue
            found.append(rel)
            walk(p, depth + 1)

    walk(root_real, 1)
    return sorted(found, key=str.lower)


def _payload(folders: list[str], root: Path, max_depth: int, root_mtime: float | None) -> dict[str, Any]:
    return {
        "folders": folders,
        "root": str(root.resolve()),
        "max_depth": max_depth,
        "listed_at": time.time(),
        "root_mtime": root_mtime,
    }


def _load_disk(config_dir: Path) -> dict[str, Any] | None:
    path = cache_path(config_dir)
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("folders"), list):
        return None
    return data


def _save_disk(config_dir: Path, payload: dict[str, Any]) -> None:
    path = cache_path(config_dir)
    try:
        ensure_dir(config_dir)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=0) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        logger.debug("Could not persist folders cache to %s", path, exc_info=True)


def _is_fresh(
    payload: dict[str, Any],
    *,
    root: Path,
    max_depth: int,
    ttl_sec: float,
) -> bool:
    try:
        listed_at = float(payload.get("listed_at") or 0)
    except (TypeError, ValueError):
        return False
    if (time.time() - listed_at) > ttl_sec:
        return False
    if int(payload.get("max_depth") or -1) != max_depth:
        return False
    try:
        cached_root = Path(str(payload.get("root") or "")).resolve()
        if cached_root != root.resolve():
            return False
    except OSError:
        return False
    cached_mtime = payload.get("root_mtime")
    current_mtime = _root_mtime(root)
    if cached_mtime is not None and current_mtime is not None:
        try:
            if abs(float(cached_mtime) - float(current_mtime)) > 1e-6:
                # Root mtime changed (new/removed top-level dir) — treat as stale.
                return False
        except (TypeError, ValueError):
            return False
    return True


def get_folders(
    *,
    root: Path,
    config_dir: Path,
    max_depth: int = 4,
    ttl_sec: float = DEFAULT_TTL_SEC,
    force: bool = False,
    lister: Callable[[Path], list[str]] | None = None,
) -> tuple[list[str], dict[str, Any]]:
    """
    Return (folders, meta) where meta includes cache hit info.

    Serves memory → disk → live walk. Live results refresh both caches.
    """
    global _mem
    ensure_dir(root)
    list_fn = lister or (lambda r: list_keeper_subdirs(r, max_depth=max_depth))

    with _lock:
        if not force and _mem is not None and _is_fresh(_mem, root=root, max_depth=max_depth, ttl_sec=ttl_sec):
            return list(_mem["folders"]), {
                "cache": "memory",
                "listed_at": _mem["listed_at"],
                "ttl_sec": ttl_sec,
            }

        if not force:
            disk = _load_disk(config_dir)
            if disk is not None and _is_fresh(disk, root=root, max_depth=max_depth, ttl_sec=ttl_sec):
                _mem = disk
                return list(disk["folders"]), {
                    "cache": "disk",
                    "listed_at": disk["listed_at"],
                    "ttl_sec": ttl_sec,
                }

        folders = list_fn(root)
        payload = _payload(folders, root, max_depth, _root_mtime(root))
        _mem = payload
        _save_disk(config_dir, payload)
        return list(folders), {
            "cache": "miss" if not force else "refresh",
            "listed_at": payload["listed_at"],
            "ttl_sec": ttl_sec,
        }


def invalidate(config_dir: Path | None = None) -> None:
    """Drop memory cache and optionally remove disk cache file."""
    global _mem
    with _lock:
        _mem = None
        if config_dir is not None:
            path = cache_path(config_dir)
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.debug("Could not remove folders cache %s", path, exc_info=True)


def bump_after_mutate(config_dir: Path, root: Path, max_depth: int = 4) -> None:
    """
    After create-folder (or similar), invalidate then rebuild so the next GET
    is immediate and consistent.
    """
    invalidate(config_dir)
    get_folders(root=root, config_dir=config_dir, max_depth=max_depth, force=True)
