# Unraid Add Container — invoke-library

Automated GraphQL create is **not** available (Unraid API only start/stop/update/remove). Use SSH `docker run` or Docker → Add Container.

## Fastest path (Mac on LAN with SSH to Unraid)

```bash
# from repo root (after release unraid-image exists, or with local tar)
scp deploy/invoke-library-image.tar root@192.168.1.12:/tmp/
ssh root@192.168.1.12 'IMAGE_TAR=/tmp/invoke-library-image.tar bash -s' < deploy/unraid-docker-run.sh
```

Or one-shot download+run on Unraid once the GitHub release asset is published:

```bash
ssh root@192.168.1.12 'bash -s' < deploy/unraid-docker-run.sh
```

## Add Container (UI) fields

**Icon URL:** `https://raw.githubusercontent.com/mbriney/invoke-library/main/unraid/icon.png`


| Field | Value |
|-------|--------|
| Name | `invoke-library` |
| Repository | `ghcr.io/mbriney/invoke-library:latest` (after `docker load`, or build locally) |
| Network Type | Bridge |
| Privileged | Off |
| Restart policy | unless-stopped |

### Port
| Host | Container |
|------|-----------|
| 8091 | 8080 |

### Paths
| Host | Container | Mode |
|------|-----------|------|
| `/mnt/user/appdata/invokeai/outputs` | `/data/invoke-outputs` | RO |
| `/mnt/user/Friends` | `/data/keepers` | RW |
| `/mnt/user/appdata/invoke-library` | `/data/config` | RW |

### Variables
| Key | Value |
|-----|--------|
| `INVOKE_BASE_URL` | `http://192.168.1.12:9091` |
| `INVOKE_API_TOKEN` | _(empty — Matt must set multiuser JWT)_ |
| `KEEP_DIR` | `/data/keepers` |
| `KEEP_LABEL` | `Friends` |
| `APP_TITLE` | `Invoke Library` |
| `INVOKE_OUTPUTS_DIR` | `/data/invoke-outputs` |
| `CONFIG_DIR` | `/data/config` |
| `IMAGE_SUBDIR` | `images` |

Template XML: `unraid/my-invoke-library.xml`

## Smoke test (Mac)

```bash
curl -sS http://192.168.1.12:8091/health
curl -sS 'http://192.168.1.12:8091/api/images?limit=5'
```

## Token

`https://imagine.briney.me` / `:9091` requires multiuser login (401 without token). Leave `INVOKE_API_TOKEN` empty for deploy; set later after Matt obtains JWT via `/api/v1/auth/login` (do not paste password into chat).
