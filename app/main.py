from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import secrets

from app.config import Settings, get_settings
from app.images import get_or_make_thumb, list_images, resolve_output_image
from app.invoke_client import InvokeAPIError, InvokeClient
from app.paths import PathEscapeError, ensure_dir, folder_name_ok, resolve_under, safe_relpath

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("invoke_library")

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Invoke Library", version="0.1.0")
security = HTTPBasic(auto_error=False)


def settings_dep() -> Settings:
    return get_settings()


def require_basic(
    credentials: Annotated[HTTPBasicCredentials | None, Depends(security)],
    settings: Annotated[Settings, Depends(settings_dep)],
) -> None:
    if not settings.basic_auth_enabled:
        return
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Basic"},
        )
    user_ok = secrets.compare_digest(credentials.username, settings.basic_auth_user)
    pass_ok = secrets.compare_digest(credentials.password, settings.basic_auth_password)
    if not (user_ok and pass_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )


AuthDep = Annotated[None, Depends(require_basic)]
SettingsDep = Annotated[Settings, Depends(settings_dep)]


class PathsBody(BaseModel):
    paths: list[str] = Field(min_length=1)


class CopyMoveBody(BaseModel):
    paths: list[str] = Field(min_length=1)
    dest_folder: str = Field(min_length=1)


class CreateFolderBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@app.on_event("startup")
async def startup() -> None:
    s = get_settings()
    ensure_dir(s.config_dir)
    ensure_dir(s.thumb_cache_dir)
    ensure_dir(s.archive_dir)
    logger.info(
        "invoke-library ready outputs=%s keep=%s config=%s invoke=%s",
        s.invoke_outputs_dir,
        s.archive_dir,
        s.config_dir,
        s.invoke_base_url,
    )


@app.get("/health")
async def health(settings: SettingsDep) -> dict:
    client = InvokeClient(settings)
    invoke = await client.health_ping()
    return {
        "status": "ok",
        "app": settings.app_title,
        "outputs_dir": str(settings.invoke_outputs_dir),
        "keep_dir": str(settings.archive_dir),
        "invoke": invoke,
    }


@app.get("/api/config")
async def api_config(_: AuthDep, settings: SettingsDep) -> dict:
    return {
        "app_title": settings.app_title,
        "keep_label": settings.keep_label,
        "image_subdir": settings.image_subdir,
    }


@app.get("/api/images")
async def api_images(
    _: AuthDep,
    settings: SettingsDep,
    page: int = Query(1, ge=1),
    limit: int = Query(48, ge=1, le=200),
) -> dict:
    return list_images(settings, page=page, limit=limit)


@app.get("/api/images/thumb")
async def api_thumb(
    _: AuthDep,
    settings: SettingsDep,
    path: str = Query(..., min_length=1),
):
    try:
        thumb = get_or_make_thumb(settings, path)
    except PathEscapeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "Image not found") from exc
    except Exception as exc:
        logger.exception("thumb failed for %s", path)
        raise HTTPException(500, f"Thumbnail failed: {exc}") from exc
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/images/file")
async def api_file(
    _: AuthDep,
    settings: SettingsDep,
    path: str = Query(..., min_length=1),
):
    try:
        src = resolve_output_image(settings, path)
    except PathEscapeError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not src.is_file():
        raise HTTPException(404, "Image not found")
    media = "image/png"
    ext = src.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        media = "image/jpeg"
    elif ext == ".webp":
        media = "image/webp"
    elif ext == ".gif":
        media = "image/gif"
    return FileResponse(src, media_type=media)


@app.get("/api/keepers/folders")
@app.get("/api/friends/folders")  # back-compat alias
async def list_keeper_folders(_: AuthDep, settings: SettingsDep) -> dict:
    root = settings.archive_dir
    ensure_dir(root)
    folders = sorted(
        [p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")],
        key=str.lower,
    )
    return {"folders": folders, "keep_label": settings.keep_label}


@app.post("/api/keepers/folders")
@app.post("/api/friends/folders")
async def create_keeper_folder(
    _: AuthDep,
    settings: SettingsDep,
    body: CreateFolderBody,
) -> dict:
    name = body.name.strip()
    if not folder_name_ok(name):
        raise HTTPException(400, "Invalid folder name")
    dest = settings.archive_dir / name
    try:
        dest = resolve_under(settings.archive_dir, name)
    except PathEscapeError as exc:
        raise HTTPException(400, str(exc)) from exc
    if dest.exists():
        if not dest.is_dir():
            raise HTTPException(400, "Path exists and is not a folder")
        return {"ok": True, "folder": name, "created": False}
    dest.mkdir(parents=False, exist_ok=False)
    return {"ok": True, "folder": name, "created": True}


def _resolve_sources(settings: Settings, paths: list[str]) -> list[tuple[str, Path]]:
    resolved: list[tuple[str, Path]] = []
    for rel in paths:
        try:
            p = resolve_output_image(settings, rel)
        except PathEscapeError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not p.is_file():
            raise HTTPException(404, f"Not found: {rel}")
        resolved.append((rel, p))
    return resolved


def _copy_to_keeper(settings: Settings, sources: list[tuple[str, Path]], dest_folder: str) -> list[dict]:
    if not folder_name_ok(dest_folder):
        raise HTTPException(400, "Invalid destination folder")
    try:
        dest_dir = resolve_under(settings.archive_dir, dest_folder)
    except PathEscapeError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not dest_dir.is_dir():
        raise HTTPException(404, f"Destination folder does not exist: {dest_folder}")

    results = []
    for rel, src in sources:
        target = dest_dir / src.name
        if target.exists():
            stem, suffix = src.stem, src.suffix
            n = 1
            while target.exists():
                target = dest_dir / f"{stem}_{n}{suffix}"
                n += 1
        shutil.copy2(src, target)
        results.append(
            {
                "path": rel,
                "dest": safe_relpath(target, settings.archive_dir),
                "image_name": src.name,
            }
        )
    return results


@app.post("/api/actions/copy")
async def action_copy(_: AuthDep, settings: SettingsDep, body: CopyMoveBody) -> dict:
    sources = _resolve_sources(settings, body.paths)
    copied = _copy_to_keeper(settings, sources, body.dest_folder.strip())
    return {"ok": True, "action": "copy", "results": copied}


@app.post("/api/actions/delete")
async def action_delete(_: AuthDep, settings: SettingsDep, body: PathsBody) -> dict:
    sources = _resolve_sources(settings, body.paths)
    image_names = [p.name for _, p in sources]
    client = InvokeClient(settings)
    try:
        api_result = await client.delete_images(image_names)
    except InvokeAPIError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(exc),
                "invoke_status": exc.status_code,
                "hint": "Delete only goes through InvokeAI REST — filesystem was not modified.",
            },
        ) from exc

    deleted = api_result.get("deleted_images", image_names) if isinstance(api_result, dict) else image_names
    return {
        "ok": True,
        "action": "delete",
        "requested": image_names,
        "deleted_images": deleted,
        "invoke_response": api_result,
    }


@app.post("/api/actions/move")
async def action_move(_: AuthDep, settings: SettingsDep, body: CopyMoveBody) -> dict:
    """Copy to keepers, then delete via Invoke API (DB stays in sync)."""
    sources = _resolve_sources(settings, body.paths)
    copied = _copy_to_keeper(settings, sources, body.dest_folder.strip())
    image_names = [c["image_name"] for c in copied]
    client = InvokeClient(settings)
    try:
        api_result = await client.delete_images(image_names)
    except InvokeAPIError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(exc),
                "invoke_status": exc.status_code,
                "copied": copied,
                "hint": "Files were copied to keepers, but Invoke delete failed — originals were NOT removed.",
            },
        ) from exc

    deleted = api_result.get("deleted_images", image_names) if isinstance(api_result, dict) else image_names
    return {
        "ok": True,
        "action": "move",
        "results": copied,
        "deleted_images": deleted,
        "invoke_response": api_result,
    }


@app.get("/", response_class=HTMLResponse)
async def index(_: AuthDep, settings: SettingsDep):
    index_path = STATIC_DIR / "index.html"
    html = index_path.read_text(encoding="utf-8")
    html = html.replace("{{APP_TITLE}}", settings.app_title).replace("{{KEEP_LABEL}}", settings.keep_label)
    return HTMLResponse(html)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.exception_handler(PathEscapeError)
async def path_escape_handler(_request: Request, exc: PathEscapeError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})
