# adobe2api-plus / KR handoff

Last updated: 2026-09-04 13:56 (Asia/Shanghai).

## Current status

- `adobe2api-plus` is deployed as an independent service, not as a Sub2API component.
- Public endpoint: `https://adobe2api.aimasker.com`; server root: `/opt/adobe2api-plus`; local task root: `E:\APP\codex\主机维护\KR主机\adobe2api-plus`.
- Image/source deployment commit: `01e4de394808e374c64b5073cedec99c5dad7867`.
- Audited upstream baseline: `011813639b99a51f0e16d8e51481147c578d102c`, tree `866ccc5eb6ea08a855f06b1d789fa751b2766afd`. At audit time the `lecview` Fork and `songsongQAQ` upstream were identical (ahead 0, behind 0).
- Running Compose project: `aimasker-adobe2api-plus`; only MySQL and Web are present and healthy.
- Worker and mint are absent. Do not enable the `upstream` profile without explicit approval.

## Runtime layout

- MySQL image: `mysql@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b`.
- Web and MySQL share only `aimasker-adobe2api-plus_backend`, an internal bridge on `172.30.83.0/24`; Web has fixed address `172.30.83.3` and no default route.
- Named volumes: `aimasker-adobe2api-plus_mysql-data` and `aimasker-adobe2api-plus_generated-media`.
- Docker 29 does not publish a host port for an internal bridge. A separate host Nginx listener exposes only `127.0.0.1:8300`, then proxies to the fixed internal Web address. The public TLS site proxies only to that loopback endpoint.
- MySQL has no host port. The dormant mint definition has no host port. The profile-only egress network is not created while Worker/mint remain disabled.

## Security boundary

- Runtime secrets exist only in `/opt/adobe2api-plus/private/.env` (root-owned mode `0600`) and the local ignored `private/kr-production.env`.
- The deployed values are strong random values, not `admin/admin` or repository defaults. Documents and Git contain variable names only.
- Exactly one administrator was bootstrapped server-side. Its name/password and session value were not printed or copied into logs or documentation.
- The authentication cookie was verified as `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`.
- No Adobe account, Token, Cookie, service API key or generation job was imported or created. No image/video generation, paid request, Adobe probe or load test was run.
- Worker startup would immediately enter the Sherlock refresh loop and call mint; mint would open Adobe Firefly and load the Sherlock SDK. This is why both remain gated.

## Verified state

- `https://adobe2api.aimasker.com/login` and five sampled Next static assets: HTTP 200.
- `/api/health`: 200; unauthenticated `/api/admin/accounts`: 401; unauthenticated `POST /api/v1/generate`: 401; `/admin`: 307 to login; HTTP redirects to HTTPS with 301.
- Wildcard `aimasker.com` Let's Encrypt certificate covers the hostname and expires 2026-11-28 15:45:07 UTC.
- DNS is an unproxied A record to `43.128.140.43`. The final Cloudflare operation was idempotent and did not overwrite the matching record.
- Restart recovery preserved one admin and one session; Adobe accounts, Adobe tokens and jobs remained zero. Log pattern scan found no credentials and no Web error/fatal patterns.
- Sub2API remained version `0.2.0` / commit `aa236488351eb71e120fc2b6fb32e36b0374c918`; all three existing containers stayed healthy, `127.0.0.1:8081` and its Docker network were unchanged, and the enabled Sub2API Nginx file retained SHA-256 `7e919a67baf4660ccd25425d1b9be5c093d6c62686f61587638b0f9152677048`.

See `DEPLOYMENT.md` for immutable build data and upgrade procedure. Read `BACKUP-RESTORE.md` before rollback or restore.

