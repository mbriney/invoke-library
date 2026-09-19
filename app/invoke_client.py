from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


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

    async def health_ping(self) -> dict[str, Any]:
        """Best-effort connectivity check against InvokeAI."""
        url = f"{self.base_url}/api/v1/app/version"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resp = await client.get(url, headers=self._headers())
            return {"ok": resp.status_code < 500, "status_code": resp.status_code}
        except httpx.RequestError as exc:
            return {"ok": False, "error": str(exc)}
