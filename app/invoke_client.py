from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

# Best-effort ImageDTO map cache (shared across requests)
_DTO_MAP_CACHE: dict[str, dict] | None = None
_DTO_MAP_CACHE_AT: float = 0.0
_DTO_MAP_TTL_SEC = 300.0


def peek_cached_dto_map() -> dict[str, dict] | None:
    """Return in-memory ImageDTO map if present (may be stale). Never fetches."""
    return _DTO_MAP_CACHE


class InvokeAPIError(Exception):
    def __init__(self, message: str, status_code: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class InvokeClient:
    """Thin client for InvokeAI image delete API (v6.x)."""

    def __init__(self, settings: Settings):
        self.base_url = settings.invoke_base_url.rstrip("/")
        self.token = (settings.invoke_api_token or "").strip()
        self.api_key = (settings.invoke_api_key or "").strip()
        self._timeout = httpx.Timeout(60.0, connect=10.0)

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            # Multi-user JWT or any Bearer token
            headers["Authorization"] = f"Bearer {self.token}"
        elif self.api_key:
            # Alternate header style some deployments use
            headers["X-API-Key"] = self.api_key
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def delete_images(self, image_names: list[str]) -> dict[str, Any]:
        """POST /api/v1/images/delete with {"image_names": [...]}."""
        if not image_names:
            return {"deleted_images": []}

        url = f"{self.base_url}/api/v1/images/delete"
        payload = {"image_names": image_names}

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(url, json=payload, headers=self._headers())
        except httpx.RequestError as exc:
            raise InvokeAPIError(f"InvokeAI unreachable: {exc}") from exc

        if resp.status_code >= 400:
            raise InvokeAPIError(
                f"InvokeAI delete failed ({resp.status_code}): {resp.text[:500]}",
                status_code=resp.status_code,
                body=resp.text[:2000],
            )

        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text, "deleted_images": image_names}

        return data


    async def get_image(self, image_name: str) -> dict[str, Any] | None:
        """GET /api/v1/images/i/{image_name} — returns ImageDTO or None on 404."""
        url = f"{self.base_url}/api/v1/images/i/{image_name}"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=3.0)) as client:
                resp = await client.get(url, headers=self._headers())
        except httpx.RequestError as exc:
            logger.debug("Invoke get_image failed for %s: %s", image_name, exc)
            return None
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            logger.debug("Invoke get_image %s status %s", image_name, resp.status_code)
            return None
        try:
            data = resp.json()
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    async def list_images_page(
        self,
        *,
        categories: list[str] | None = None,
        image_origin: str | None = None,
        is_intermediate: bool = False,
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, Any] | None:
        """GET /api/v1/images/ — OffsetPaginatedResults[ImageDTO]."""
        params: list[tuple[str, str]] = [
            ("is_intermediate", "true" if is_intermediate else "false"),
            ("offset", str(offset)),
            ("limit", str(limit)),
        ]
        if image_origin:
            params.append(("image_origin", image_origin))
        if categories:
            for c in categories:
                params.append(("categories", c))
        url = f"{self.base_url}/api/v1/images/"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0)) as client:
                resp = await client.get(url, headers=self._headers(), params=params)
        except httpx.RequestError as exc:
            logger.debug("Invoke list_images failed: %s", exc)
            return None
        if resp.status_code >= 400:
            logger.debug("Invoke list_images status %s: %s", resp.status_code, resp.text[:200])
            return None
        try:
            data = resp.json()
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    async def build_image_dto_map(self, *, max_pages: int = 30, page_size: int = 100, force: bool = False) -> dict[str, dict[str, Any]]:
        """Best-effort map of image_name -> ImageDTO across gallery + asset categories."""
        import time

        global _DTO_MAP_CACHE, _DTO_MAP_CACHE_AT
        now = time.monotonic()
        if (
            not force
            and _DTO_MAP_CACHE is not None
            and (now - _DTO_MAP_CACHE_AT) < _DTO_MAP_TTL_SEC
        ):
            return _DTO_MAP_CACHE

        out: dict[str, dict[str, Any]] = {}
        sweeps: list[dict[str, Any]] = [
            {"categories": ["general"], "image_origin": None},
            {"categories": ["user", "control", "mask", "other"], "image_origin": None},
            {"categories": None, "image_origin": "external"},
        ]
        for sweep in sweeps:
            offset = 0
            for _ in range(max_pages):
                data = await self.list_images_page(
                    categories=sweep["categories"],
                    image_origin=sweep["image_origin"],
                    is_intermediate=False,
                    offset=offset,
                    limit=page_size,
                )
                if not data:
                    break
                items = data.get("items") or data.get("results") or []
                if not isinstance(items, list) or not items:
                    break
                for it in items:
                    if isinstance(it, dict) and it.get("image_name"):
                        out[str(it["image_name"])] = it
                total = data.get("total")
                offset += page_size
                if total is not None and offset >= int(total):
                    break
                if len(items) < page_size:
                    break
        _DTO_MAP_CACHE = out
        _DTO_MAP_CACHE_AT = time.monotonic()
        return out

    async def health_ping(self) -> dict[str, Any]:
        """Best-effort connectivity check against InvokeAI."""
        url = f"{self.base_url}/api/v1/app/version"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resp = await client.get(url, headers=self._headers())
            return {"ok": resp.status_code < 500, "status_code": resp.status_code}
        except httpx.RequestError as exc:
            return {"ok": False, "error": str(exc)}
