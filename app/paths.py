from __future__ import annotations

import os
from pathlib import Path


class PathEscapeError(ValueError):
    """Raised when a path escapes an allowed root."""


def resolve_under(root: Path, relative: str | Path) -> Path:
    """Resolve *relative* under *root*; reject escapes via .. or symlinks."""
    root_real = root.resolve()
    if not root_real.exists():
        raise FileNotFoundError(f"Root does not exist: {root_real}")

    candidate = Path(relative)
    if candidate.is_absolute():
        # Absolute paths must still land under root after resolve
        target = candidate.resolve()
    else:
        target = (root_real / candidate).resolve()

    try:
        target.relative_to(root_real)
    except ValueError as exc:
        raise PathEscapeError(f"Path escapes allowed root: {relative}") from exc

    return target


def safe_relpath(path: Path, root: Path) -> str:
    root_real = root.resolve()
    path_real = path.resolve()
    return path_real.relative_to(root_real).as_posix()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def folder_name_ok(name: str) -> bool:
    if not name or name.strip() != name:
        return False
    if name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
        return False
    # Reject path separators and relative components
    if os.sep in name or (os.altsep and os.altsep in name):
        return False
    return True

def folder_relpath_ok(rel: str, *, max_depth: int = 4) -> bool:
    """Validate a relative folder path under KEEP_DIR (allows nested segments)."""
    if not rel or rel.strip() != rel:
        return False
    if "\0" in rel or rel.startswith("/") or rel.startswith("\\"):
        return False
    # Normalize separators to /
    parts = rel.replace("\\", "/").split("/")
    if not parts or any(p == "" for p in parts):
        return False
    if len(parts) > max_depth:
        return False
    for p in parts:
        if p in (".", "..") or not folder_name_ok(p):
            return False
    return True
