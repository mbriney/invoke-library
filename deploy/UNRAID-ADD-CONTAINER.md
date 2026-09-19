# Unraid Add Container — invoke-library

**Image:** `ghcr.io/mbriney/invoke-library:latest`  
**Template URL:** https://raw.githubusercontent.com/mbriney/invoke-library/main/unraid/my-invoke-library.xml

## Docker → Add Container

| Field | Value |
|-------|--------|
| Name | `invoke-library` |
| Repository | `ghcr.io/mbriney/invoke-library:latest` |
| Network Type | Bridge |
| Console shell | bash |
| Privileged | Off |
| Restart policy | unless-stopped |

### Port

| Host | Container | Protocol |
|------|-----------|----------|
| 8091 | 8080 | TCP |

### Paths

| Host | Container | Mode |
|------|-----------|------|
| `/mnt/user/appdata/invokeai/outputs` | `/data/invoke-outputs` | Read-only |
| `/mnt/user/Friends` | `/data/keepers` | Read/Write |
| `/mnt/user/appdata/invoke-library` | `/data/config` | Read/Write |

Create `/mnt/user/appdata/invoke-library` on the Array if missing.

### Variables

| Key | Value |
|-----|--------|
| `INVOKE_BASE_URL` | `http://192.168.1.12:9091` |
| `INVOKE_API_TOKEN` | _(leave empty unless you set a multiuser JWT)_ |
| `KEEP_DIR` | `/data/keepers` |
| `KEEP_LABEL` | `Friends` |
| `APP_TITLE` | `Invoke Library` |
| `INVOKE_OUTPUTS_DIR` | `/data/invoke-outputs` |

## Or SSH one-liner (from Mac on LAN)

```bash
ssh root@192.168.1.12 'bash -s' < deploy/unraid-docker-run.sh
```

## Smoke test (from Mac)

```bash
curl -sS http://192.168.1.12:8091/health
curl -sS 'http://192.168.1.12:8091/api/images?limit=5'
```

## INVOKE_API_TOKEN

Invoke at `imagine.briney.me` / `:9091` returns **401** without auth (multiuser).  
Obtain JWT yourself (do not paste password into chat):

```bash
curl -s -X POST 'http://192.168.1.12:9091/api/v1/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD","remember_me":true}' \
  | jq -r .token
```

Set as container env `INVOKE_API_TOKEN`, then restart the container. Health and local file listing may work without it; Invoke delete API will need the token.
