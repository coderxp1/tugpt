# Dev host hardening, 2026-11-15 (VPS 82.165.50.109, GPU 82.165.178.153)

Development environment only. Production (Supabase `rbiumegrwtavmljxbknp`) was not touched.

## 1. Local Supabase ports moved to loopback

**Before.** `supabase_db_tugpt-connect-p0` (Postgres) published `0.0.0.0:56322` and `[::]:56322`, and `supabase_kong_tugpt-connect-p0` (API gateway) published `0.0.0.0:56321` and `[::]:56321`. Both were reachable from the internet.

**Change.** `/srv/tugpt-workspace/ops/rebind_loopback.py <container>` recreates each container through the Docker API with identical configuration and `HostIp: 127.0.0.1`.
- Volumes are untouched.
- The originals are kept, stopped, as `<name>-public-old` for rollback.

**After.**
- `ss -ltn` shows `127.0.0.1:56321` and `127.0.0.1:56322` only.
- TCP connects to `82.165.50.109:56321/56322` are refused, while loopback works.
- Data survived: existing chat threads load.

**Caveat.** Running `supabase start` or `supabase stop && supabase start` for this project recreates the containers with the CLI defaults, which publish ports on all interfaces again. Before doing that, either:
- set `[api] / [db]` bind addresses in `supabase/config.toml` if your CLI version supports it, or
- rerun the rebind script and recheck with `ss -ltn | grep 5632`.

**Rollback.**

```sh
docker rm -f <name>
docker rename <name>-public-old <name>
docker start <name>
```

Remove the `-public-old` containers once you are satisfied.

## 2. GPU image tunnel

| Item | Value |
|---|---|
| GPU account | `tugpt-image`, shell `nologin`, home `/var/lib/tugpt-image` |
| authorized_keys | `from="82.165.50.109",restrict,port-forwarding,permitopen="127.0.0.1:18765"` |
| sshd | `Match User tugpt-image`: `AllowTcpForwarding local`, `PermitOpen 127.0.0.1:18765`, `PermitTTY no`, `MaxSessions 0`, no agent, X11, tunnel or user rc. Backup: `/etc/ssh/sshd_config.bak-20261115-image`. |
| VPS key | `/etc/tugpt-gpu-image/id_ed25519` (0600 root), separate from the Ollama broker key |
| VPS unit | `tugpt-gpu-image-tunnel.service`, `-N -L 127.0.0.1:18766:127.0.0.1:18765`, `StrictHostKeyChecking=yes`, `ExitOnForwardFailure=yes` |
| Token | `/etc/tugpt-gpu-image/api-token` (0600 root, 64 bytes) |

**Negative checks performed.**
- An interactive command over the key is refused.
- `-L` to `127.0.0.1:11434` (Ollama) and to `127.0.0.1:22` is "administratively prohibited".
- An unauthenticated `/health` returns 401.

**Token provisioning.** The token was copied GPU→VPS machine to machine with the admin root key, straight into the 0600 file. It was never printed or logged.
- That was a one-time admin step: customer code never uses the admin key.
- **Rotate:** write a new token on the GPU (`/srv/tugpt-ai/state/api-token`), restart `tugpt-image.service` there, then repeat the copy. The web app picks the new token up on its next request.

**Disable image generation.** Either `systemctl disable --now tugpt-gpu-image-tunnel` on the VPS, or remove the key line on the GPU. The Create page then shows "Temporarily unavailable". It never shows a false "Ready".
