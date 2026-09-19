from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All paths/URLs come from env — no host-specific defaults."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    invoke_base_url: str = "http://127.0.0.1:9090"
    invoke_api_token: str = ""
    invoke_api_key: str = ""

    invoke_outputs_dir: Path = Path("/data/invoke-outputs")
    # Neutral keepers/archive destination (preferred)
    keep_dir: Path | None = None
    # Back-compat alias for keep_dir
    friends_dir: Path | None = None

    config_dir: Path = Path("/data/config")
    thumbs_dir: Path | None = None  # defaults to CONFIG_DIR/thumbs

    # Subfolder under outputs to prefer when listing (empty = whole tree)
    image_subdir: str = "images"

    port: int = 8080
    basic_auth_user: str = ""
    basic_auth_password: str = ""

    app_title: str = "Invoke Library"
    keep_label: str = "Keepers"  # UI label for KEEP_DIR destination

    thumb_max_size: int = 320
    thumb_quality: int = 82

    @model_validator(mode="after")
    def _resolve_keep_and_thumbs(self) -> Settings:
        if self.keep_dir is None:
            # Prefer KEEP_DIR; fall back to FRIENDS_DIR; then /data/keepers
            self.keep_dir = self.friends_dir or Path("/data/keepers")
        if self.thumbs_dir is None:
            self.thumbs_dir = self.config_dir / "thumbs"
        return self

    @property
    def thumb_cache_dir(self) -> Path:
        assert self.thumbs_dir is not None
        return self.thumbs_dir

    @property
    def archive_dir(self) -> Path:
        assert self.keep_dir is not None
        return self.keep_dir

    @property
    def basic_auth_enabled(self) -> bool:
        return bool(self.basic_auth_user and self.basic_auth_password)


@lru_cache
def get_settings() -> Settings:
    return Settings()
