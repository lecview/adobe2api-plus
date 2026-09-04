# KR deployment and upgrade procedure

Last updated: 2026-09-04 23:00 (Asia/Shanghai).

## Current immutable deployment

- Source/deployment commit: `5a0134f723fd70fb5685131677affbf09e7708da`.
- Pull request: `https://github.com/lecview/adobe2api-plus/pull/1`.
- Successful linux/amd64 workflow: `https://github.com/lecview/adobe2api-plus/actions/runs/33884343710`.
- Release: `https://github.com/lecview/adobe2api-plus/releases/tag/deployment-5a0134f723fd70fb5685131677affbf09e7708da`.
- Archive: `adobe2api-plus-images-5a0134f723fd70fb5685131677affbf09e7708da-33884343710-1.tar.zst`, 561,258,554 bytes, SHA-256 `2e934d7e77026d374c051ac180f81d6315d329c708bd5f12f3c43bb732169829`.
- CI OCI config digests: Web `sha256:42f7074d46ffe6ffe5c667197a11f62237d4c034b246d1ecb4bc057687ab0dbc`; mint `sha256:04e13da2d0b92f5651f67fe1593e2f3b2386269242b662225724f3ef5b0d2278`.
- KR Docker manifest/image ID for the loaded Web image: `sha256:bb9496a43ca32b1df0cccb5e00adc20677a2491144c2bc9c2aed31c5507f423b`.

The release archive and every file in its checksum manifest were verified before `docker load`. KR did not build images. CI passed lint, typecheck, MySQL migration/integration coverage, the test suite, production high-severity dependency audit, production build and isolated Compose expansion.

## Production layout

| Item | Value |
|---|---|
| Host | KR `VM-4-190-ubuntu`, `43.128.140.43`, linux/amd64 |
| Server directory | `/opt/adobe2api-plus` |
| Compose project | `aimasker-adobe2api-plus` |
| Compose file | `/opt/adobe2api-plus/deploy/kr/docker-compose.yml` |
| Private environment | `/opt/adobe2api-plus/private/.env`, root:root, `0600` |
| Public hostname | `adobe2api.aimasker.com` |
| Host-only bridge | `127.0.0.1:8300` via independent Nginx listener |
| Networks | `aimasker-adobe2api-plus_backend`; Worker/mint also use `aimasker-adobe2api-plus_egress` |
| Volumes | `aimasker-adobe2api-plus_mysql-data`, `aimasker-adobe2api-plus_generated-media` |
| DNS | unproxied A to `43.128.140.43`, TTL 300 at final check |
| Certificate | `aimasker.com` / `*.aimasker.com`, expires 2026-11-28 |

Resource/log limits:

| Service | CPU | Memory | PIDs | Log rotation | Host ports |
|---|---:|---:|---:|---|---|
| MySQL | 0.35 | 512 MiB | 256 | json-file 10 MiB x 3 | none |
| Web | 0.45 | 640 MiB | 256 | json-file 10 MiB x 3 | none; Nginx loopback only |
| Worker | 0.35 | 512 MiB | 256 | json-file 10 MiB x 3 | none |
| mint | 0.50 | 768 MiB | 384 | json-file 10 MiB x 3 | none |

## Deployment performed

1. Captured production container, network, volume, port, resource, HTTP and Nginx-hash baselines.
2. Waited for CI and immutable release success; verified the archive manifest on KR and loaded the linux/amd64 images.
3. Updated only `DEPLOY_SHA` and `WEB_IMAGE` in the mode-0600 environment. The deployment did not change the Compose file, Nginx, DNS, MySQL image/volume or mint container.
4. Recreated only this project's Web and Worker with `--no-deps --force-recreate --wait`.
5. Verified health, HTTPS/static assets, unauthorized rejection, 13 authenticated model families, fail-fast parameter validation, remote-URL mode and log error counts without sending a generation request.
6. With no live jobs or valid leases, restarted only Web/Worker and verified both returned healthy.
7. Captured the post-deployment snapshot and rechecked existing sites.

## Upgrade flow

Use this sequence and never auto-overwrite AIMasker deployment customization:

```text
fetch upstream -> review differences -> local/CI tests -> merge -> package fixed linux/amd64 images -> snapshot -> deploy only this project -> verify -> publish receipt
```

Keep source, KR templates and project-specific docs in `lecview/adobe2api-plus`. Keep only a sanitized cross-project deployment summary in `lecview/aimasker-sub2api`.

