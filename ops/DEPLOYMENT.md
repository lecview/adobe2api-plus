# KR deployment and upgrade procedure

Last updated: 2026-09-04 (Asia/Shanghai).

## Fixed source and build

The audited upstream baseline is commit `011813639b99a51f0e16d8e51481147c578d102c` with tree `866ccc5eb6ea08a855f06b1d789fa751b2766afd`. The AIMasker deployment commit is created on `lecview/adobe2api-plus` after adding the health route, reproducible offline-font change, KR templates and CI packaging workflow.

CI must pass lint, TypeScript, unit tests, MySQL integration tests, production build, production-dependency audit and `docker compose config --quiet`. It then builds linux/amd64 Web and mint images, saves both to one `.tar.zst`, writes image IDs/build metadata/SHA-256, and publishes unique immutable assets on release tag `deployment-<commit>`.

Production downloads that release asset and verifies SHA-256 before `docker load`. Production does not build source or images.

## First deployment

1. Confirm the Fork main commit has not moved unexpectedly and read the CI result.
2. Snapshot Sub2API containers, ports, networks, volumes, resource state, health and existing websites into a new local and server backup directory.
3. Select a free port with `deploy/kr/select-port.sh`; write it to the private `.env`.
4. Pull `mysql:8.0` on KR, record its registry digest, and pin `MYSQL_IMAGE` to that digest.
5. Download and verify the CI image archive, then `docker load` it.
6. Install only reviewed templates under `/opt/adobe2api-plus`; create `/opt/adobe2api-plus/.env` with mode `0600` and strong random values. Never use `admin/admin`, repository defaults, or a default MySQL password.
7. Run `docker compose config --quiet`, then start only `mysql` and `web`.
8. Wait for both containers to become healthy. Verify `/api/health`, `/login`, unauthenticated admin/API behavior, log redaction and named-volume persistence.
9. Bootstrap and verify the strong administrator account server-side without printing credentials.
10. Install the independent Nginx map/site candidates, replace `__WEB_PORT__`, run `nginx -t`, enable the site, run `nginx -t` again, then reload Nginx only.
11. Create only the absent DNS A record with `cloudflare-create-record.py`. It refuses to overwrite any conflicting record and stores a mode-0600 pre-change response.
12. Verify HTTPS, certificate coverage, login/static assets, health, unauthorized API rejection, WebSocket/SSE proxy headers, and Sub2API before/after state.

## Upstream profile

Do not run this during the initial safe deployment:

```sh
docker compose --profile upstream up -d mint worker
```

The worker's first periodic loop can request a sherlock token; mint then opens `https://firefly.adobe.com/generate/image` and loads the Adobe Sherlock SDK. Enabling this profile therefore requires explicit approval even when no Adobe account has been imported.

## Upgrade flow

Use this sequence and never auto-overwrite local deployment customization:

```text
fetch upstream -> review commit/file differences -> local and CI tests -> merge -> package fixed images -> snapshot -> deploy -> verify
```

Keep source changes in `lecview/adobe2api-plus`. Keep only a cross-project, sanitized service summary in `lecview/aimasker-sub2api`; never copy adobe2api-plus source there.

## Production values and verification

The deployed commit, image IDs/archive SHA-256, MySQL digest, loopback port, DNS/record ID, container resources, backup paths and verification evidence are appended here after the first rollout. Sensitive values are represented only by variable names and storage locations.
