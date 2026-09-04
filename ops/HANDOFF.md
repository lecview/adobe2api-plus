# adobe2api-plus / KR handoff

Last updated: 2026-09-04 23:00 (Asia/Shanghai).

## Current production state

- `adobe2api-plus` is an independent KR service and is not a Sub2API component.
- Public endpoint: `https://adobe2api.aimasker.com`; server root: `/opt/adobe2api-plus`; local task root: `E:\APP\codex\主机维护\KR主机\adobe2api-plus`.
- Deployed source/image commit: `5a0134f723fd70fb5685131677affbf09e7708da`.
- CI run `33884343710` and immutable release `deployment-5a0134f723fd70fb5685131677affbf09e7708da` both succeeded.
- Running Compose project: `aimasker-adobe2api-plus`. Web, Worker, MySQL and mint are healthy. Worker/mint were enabled under the user's earlier explicit authorization.
- Web and Worker use `aimasker/adobe2api-plus-web:5a0134f723fd70fb5685131677affbf09e7708da`; MySQL and mint were not recreated by this deployment.

## Function delivered

- `/v1/models` now exposes exactly 13 media families rather than resolution/aspect-ratio variants: `gpt-image-2`, `nano-banana`, `nano-banana-pro`, `nano-banana2`, `sora2`, `sora2-pro`, `veo31`, `veo31-ref`, `gemini-omni`, `kling3`, `kling-o3`, `seedance20`, `seedance20-fast`.
- Resolution, ratio, duration, video resolution and audio selection are request parameters. Routing records both `requested_model` and the internal `resolved_model`.
- Production `returnOriginalUrl=1`. Successful upstream media responses return remote URLs and do not download the result into the project media volume. The post-deployment media directory was only 4096 bytes.
- Authenticated production validation returned all 13 families. An invalid `nano-banana2` ratio returned `400 / invalid_aspect_ratio` before queueing or Adobe access. The one-time validation key was hard-deleted; zero temporary rows remained.
- No paid or real generation request was submitted for this deployment validation.

## Isolation and resources

- Networks: Web/MySQL use only `aimasker-adobe2api-plus_backend`; Worker/mint additionally use `aimasker-adobe2api-plus_egress` for the already-authorized Adobe path.
- Volumes: `aimasker-adobe2api-plus_mysql-data` and `aimasker-adobe2api-plus_generated-media`.
- Host exposure remains only the independent Nginx loopback bridge at `127.0.0.1:8300`; MySQL and mint publish no host ports.
- Limits: Web 0.45 CPU/640 MiB/256 PIDs; Worker 0.35 CPU/512 MiB/256 PIDs; MySQL 0.35 CPU/512 MiB/256 PIDs; mint 0.50 CPU/768 MiB/384 PIDs. All use `json-file` rotation 10 MiB x 3.
- Runtime secrets remain only in `/opt/adobe2api-plus/private/.env` (root-owned mode `0600`) and the ignored local `private/kr-production.env`. Never copy their values into logs, docs or Git.

## Verification and observations

- Loopback health, HTTPS login and a sampled Next static asset returned 200. Unauthenticated models and image-generation endpoints returned 401. Nginx configuration test passed; Nginx/DNS/certificate configuration was not changed.
- DNS remains unproxied A `adobe2api.aimasker.com -> 43.128.140.43`. The existing `aimasker.com` / `*.aimasker.com` Let's Encrypt certificate covers the hostname and expires 2026-11-28 15:45:07 UTC.
- Web/Worker restarted independently and returned healthy. Error/exception line counts for their deployment window were zero; log contents were not exported.
- Two historical jobs remain in terminal `SUBMISSION_UNKNOWN` state. They have no live lease and no recoverable upstream task/poll pair; they were not retried or modified.
- During the post-deployment window, a separate/concurrent operation recreated Sub2API at 22:54:04 Asia/Shanghai and modified `/opt/sub2api-deploy/docker-compose.yml` at 22:54:03. The adobe2api deployment commands addressed only `aimasker-adobe2api-plus` Web/Worker. Sub2API, PostgreSQL and Redis are currently healthy and existing sites returned 200, but the pre/post Sub2API uptime is therefore not unchanged and must not be reported as such.

Read `DEPLOYMENT.md` for immutable image data and verification, `BACKUP-RESTORE.md` for exact rollback, and `GITHUB-RECEIPT.md` for publication records.

