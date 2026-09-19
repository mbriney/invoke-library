# Invoke Library

Open-source web curator for [InvokeAI](https://invoke.ai/) outputs.

Browse thumbnails of generated images, multi-select, **delete through the InvokeAI REST API** (so the gallery DB stays in sync), and **copy or move keepers** into an archive folder of your choice.

Works anywhere you can run Docker: Linux NAS (Unraid, TrueNAS), a homelab box, or bare metal next to InvokeAI.

## Features

- Mobile-friendly thumbnail grid with multi-select (**select all on page**), and per-tile **zoom** (full-resolution lightbox)
- **Input vs Output** badges and All / Outputs / Inputs filter
- Delete via InvokeAI `POST /api/v1/images/delete` (never silent filesystem-only delete)
- Copy or move selected images into configurable **Keepers** folders (nested folders + searchable picker)
- Path escape protection (`realpath` under allowed roots)
- Optional HTTP Basic Auth for the curator UI
- Cached JPEG thumbnails (Pillow)
- **Keepers folder tree cache** (server memory + `CONFIG_DIR/folders-cache.json`, ~120s TTL / root mtime; UI keeps last list warm across Move/Copy modal open)
- **Bulk action progress** (copy / move / delete): sequential per-file with determinate progress; continues after errors and reports a count

## Quick start (Docker Compose)

```bash
cp .env.example .env
# edit INVOKE_BASE_URL, volume host paths, optional INVOKE_API_TOKEN

docker compose up -d --build
# open http://localhost:8091
```

Map your Invoke outputs (read-only) and a keepers/archive directory (read-write). All container paths are configurable via environment variables.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INVOKE_BASE_URL` | `http://127.0.0.1:9090` | InvokeAI base URL (no trailing slash) |
| `INVOKE_API_TOKEN` | _(empty)_ | Bearer JWT for multi-user mode |
| `INVOKE_API_KEY` | _(empty)_ | Optional alternate auth if token unset |
| `INVOKE_OUTPUTS_DIR` | `/data/invoke-outputs` | Outputs root **inside** the container |
| `KEEP_DIR` | `/data/keepers` | Keepers/archive root inside the container |
| `FRIENDS_DIR` | — | Alias for `KEEP_DIR` (back-compat) |
| `CONFIG_DIR` | `/data/config` | App config / cache root |
| `THUMBS_DIR` | `$CONFIG_DIR/thumbs` | Thumbnail cache (optional override) |
| `IMAGE_SUBDIR` | `images` | Prefer this subfolder under outputs when listing |
| `PORT` | `8080` | Listen port inside the container |
| `APP_TITLE` | `Invoke Library` | Browser / UI title |
| `KEEP_LABEL` | `Keepers` | UI label for the archive destination |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | _(empty)_ | Optional Basic Auth for this app |

Host-specific paths (e.g. Unraid `/mnt/user/...`) belong in **volume mounts**, not in these defaults.

## Obtaining an InvokeAI API token

- **Single-user mode** (`multiuser: false` or unset): leave `INVOKE_API_TOKEN` empty — delete API calls need no auth.
- **Multi-user mode**: log in and copy the JWT:

```bash
curl -s -X POST "$INVOKE_BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"YOUR_PASSWORD","remember_me":true}' \
  | jq -r .token
```

Set that value as `INVOKE_API_TOKEN`. Tokens expire (often 24h, longer with `remember_me`); refresh when deletes start returning 401.

Auth style: `Authorization: Bearer <token>`. If you only set `INVOKE_API_KEY`, the app also sends `X-API-Key` and Bearer with that value.

## Delete API wiring

Deletes call InvokeAI (v6.x):

```http
POST /api/v1/images/delete
Content-Type: application/json

{"image_names":["uuid.png", "..."]}
```

`image_name` is derived from the file basename under outputs. If the Invoke call fails, the UI shows a clear error and **does not** fall back to raw filesystem delete for the Delete action. Move = copy to keepers, then the same Invoke delete.

## Input vs Output classification

Each thumbnail is labeled **Output**, **Input**, or **Unknown**:

1. **Invoke API** (preferred): when `INVOKE_BASE_URL` is reachable, the app maps `image_name` → ImageDTO and uses `image_origin` / `image_category` (`internal`+`general` → Output; `external` or `user`/`control`/`mask` → Input).
2. **Filesystem path**: category folders from Invoke’s `image_subfolder_strategy=type` (e.g. `images/general/…`, `images/user/…`).
3. **PNG metadata**: generation chunks such as `invokeai_metadata` → Output.

Filter chips **All | Outputs | Inputs** apply server-side (`GET /api/images?kind=`). Set `INVOKE_API_TOKEN` in multi-user mode so API classification works.

## Unraid Docker icon

Template Icon URL (also used as `net.unraid.docker.icon`):

`https://raw.githubusercontent.com/mbriney/invoke-library/main/unraid/icon.png`

In **Add Container**, paste that into the **Icon** field (or re-apply the template from `unraid/my-invoke-library.xml`). Asset source: [`unraid/icon.png`](unraid/icon.png).

## Unraid example

Container name: `invoke-library` · host port `8091` → container `8080`.

**Volume mounts (examples — change to your shares):**

| Host | Container | Mode |
|------|-----------|------|
| `/mnt/user/appdata/invokeai/outputs` | `/data/invoke-outputs` | RO |
| `/mnt/user/Friends` (or any archive share) | `/data/keepers` | RW |
| `/mnt/user/appdata/invoke-library` | `/data/config` | RW |

**Env to set:** `INVOKE_BASE_URL`, optional `INVOKE_API_TOKEN`, optional Basic Auth, optional `APP_TITLE` / `KEEP_LABEL`.

Docker run sketch:

```bash
docker run -d --name invoke-library --restart unless-stopped \
  -p 8091:8080 \
  -e INVOKE_BASE_URL=http://192.168.1.12:9091 \
  -e INVOKE_API_TOKEN= \
  -e KEEP_DIR=/data/keepers \
  -e KEEP_LABEL=Keepers \
  -v /mnt/user/appdata/invokeai/outputs:/data/invoke-outputs:ro \
  -v /mnt/user/Friends:/data/keepers \
  -v /mnt/user/appdata/invoke-library:/data/config \
  invoke-library:latest
```

Or use `docker-compose.example.yml` as a starting point.

## Local development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export INVOKE_OUTPUTS_DIR=./data/outputs KEEP_DIR=./data/keepers CONFIG_DIR=./data/config
mkdir -p "$INVOKE_OUTPUTS_DIR/images" "$KEEP_DIR" "$CONFIG_DIR"
uvicorn app.main:app --reload --port 8080
```

## API (summary)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | Liveness + Invoke ping |
| GET | `/api/images?page=&limit=&kind=` | List images (newest first; `kind`=`all\|output\|input\|unknown`) |
| GET | `/api/images/thumb?path=` | Cached JPEG thumb |
| GET | `/api/images/file?path=` | Full image (path must stay under outputs) |
| GET/POST | `/api/keepers/folders` | List recursive (served from cache; `?refresh=1` forces rescan) / create keeper subfolders (`/api/friends/folders` alias) |
| POST | `/api/keepers/folders/invalidate` | Drop memory + disk folder cache (`/api/friends/folders/invalidate` alias) |
| POST | `/api/actions/copy` | `{paths[], dest_folder}` |
| POST | `/api/actions/move` | Copy then Invoke delete |
| POST | `/api/actions/delete` | Invoke delete only |


## Keepers folder cache

Recursive listing under `KEEP_DIR` can be slow on large archive shares (e.g. Friends). The app caches the tree:

1. **In-memory** for ~120s (also invalidated when you create a folder).
2. **On disk** at `$CONFIG_DIR/folders-cache.json` so cold starts after restart stay fast.
3. Freshness also checks the **KEEP_DIR root mtime** (new top-level folders show up without waiting forever).

`GET /api/keepers/folders?refresh=1` (or the UI **Refresh folders** button) forces a rescan. The Move/Copy modal keeps the last loaded list in memory so reopening does not wait on the network when warm.

## Bulk actions & progress

Copy, move, and delete run **one image at a time** so the UI can show a determinate progress bar (`12 / 48`) and the current filename. Move is still copy-then-Invoke-delete per file.

**Error policy:** on a per-item failure the run **continues** with the rest; the panel shows an error count and the toast summarizes (`N ok, M failed`). Successful items are removed from the selection; failed ones stay selected. Confirm/Cancel are disabled while a bulk run is in progress.

## License

MIT — see [LICENSE](LICENSE).

## Security notes

- Destructive actions require UI confirmation.
- Paths are resolved with `realpath` and rejected if they escape `INVOKE_OUTPUTS_DIR` or `KEEP_DIR`.
- Prefer read-only mounts for Invoke outputs.
- Put this UI behind Basic Auth, a reverse proxy, or LAN-only access.
