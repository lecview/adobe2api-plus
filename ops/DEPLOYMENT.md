# KR deployment and upgrade procedure

Last updated: 2026-09-04 13:56 (Asia/Shanghai).

## Source, CI and immutable images

- Upstream baseline: `songsongQAQ/adobe2api-plus@011813639b99a51f0e16d8e51481147c578d102c`, tree `866ccc5eb6ea08a855f06b1d789fa751b2766afd`.
- Fork comparison at audit time: `lecview` ahead 0 / behind 0 before AIMasker changes.
- Deployed source/image commit: `01e4de394808e374c64b5073cedec99c5dad7867`.
- CI run: `https://github.com/lecview/adobe2api-plus/actions/runs/33839374314`.
- Release: `https://github.com/lecview/adobe2api-plus/releases/tag/deployment-01e4de394808e374c64b5073cedec99c5dad7867`.
- Release archive: `adobe2api-plus-images-01e4de394808e374c64b5073cedec99c5dad7867-33839374314-1.tar.zst`, 560,914,396 bytes, SHA-256 `767b6f5384ca56a5cd9785a65da518da7d5ee53003dec4f73e40437a96d459d3`.
- OCI config digests: Web `sha256:e2bc2d0b2ba7909cccec8c2a4208d15408ba5ee4f1228b49b1dc2a3b96cd60dc`; mint `sha256:9b034d6ba3508b14409e9ca80f6d1b5a1d3b039c7e88aff846b6738017f5145b`.
- OCI archive manifests / KR containerd image IDs: Web `sha256:858abf5d999a676f357d41c2c3a93ec3251bb0100881ead418c73f2af9fd08b4`; mint `sha256:4503caed8022a9f0341103ce202c3baee5e4ebe77866f0d3e8ce492620c33eb6`.
- Build metadata manifest digests: Web `sha256:a6658e3453a4637f8d45581717edbe821b6498774d3097a96e53ac97daf76eeb`; mint `sha256:a5c86f53146cdeb12241a97cf92384c3acb44e476bdc4c2647dd3f93964624ac`.

The release archive and every file listed by its internal checksum manifest were verified before `docker load`. KR did not build images. The Web image was also run once with `--network none` to verify linux/amd64, Node 22.23.2, Next 16.3.4 and production mode. The differing CI/KR display IDs are expected: CI reported the OCI config digest while the Docker 29 containerd store reports the OCI manifest digest; both referenced objects and all layers are present in the verified archive.

CI passed lint, typecheck, explicit migration, production build, Compose expansion, the production high-severity dependency audit and 208 tests with 4 skips (212 total), including all 16 MySQL integration tests. The production high-severity audit gate passed; four moderate development-only transitive findings remained locally and are not claimed as zero-risk.

## Production values

| Item | Deployed value |
|---|---|
| Host | KR `VM-4-190-ubuntu`, public IPv4 `43.128.140.43`, linux/amd64 |
| Server directory | `/opt/adobe2api-plus` |
| Compose file | `/opt/adobe2api-plus/deploy/kr/docker-compose.yml` |
| Compose project | `aimasker-adobe2api-plus` |
| Public hostname | `adobe2api.aimasker.com` |
| Host-only endpoint | `127.0.0.1:8300` (Nginx loopback bridge) |
| Internal network | `aimasker-adobe2api-plus_backend`, `172.30.83.0/24`, internal |
| Web internal address | `172.30.83.3:3000`, no default route |
| Volumes | `aimasker-adobe2api-plus_mysql-data`, `aimasker-adobe2api-plus_generated-media` |
| Runtime environment | `/opt/adobe2api-plus/private/.env`, root:root, mode `0600` |
| DNS | unproxied A `adobe2api.aimasker.com -> 43.128.140.43`, Cloudflare TTL automatic |
| Certificate | existing `aimasker.com` / `*.aimasker.com` ECDSA certificate, expires 2026-11-28 |

Resource/log limits:

| Service | CPU | Memory | PIDs | Log rotation | Host ports |
|---|---:|---:|---:|---|---|
| MySQL | 0.35 | 512 MiB | 256 | json-file 10 MiB x 3 | none |
| Web | 0.45 | 640 MiB | 256 | json-file 10 MiB x 3 | none; reached through host Nginx 127.0.0.1:8300 |
| Worker (disabled profile) | 0.35 | 512 MiB | 256 | json-file 10 MiB x 3 | none |
| mint (disabled profile) | 0.50 | 768 MiB | 384 | json-file 10 MiB x 3 | none |

At the post-deployment snapshot MySQL used about 370.5 MiB and Web 135.3 MiB; host memory available was 2.1 GiB and disk free 44 GiB. Worker/mint were absent, so their limits consumed no resources.

## Independent Nginx chain

Only these files belong to this deployment:

- `/etc/nginx/conf.d/adobe2api-plus-websocket-map.conf`
- `/etc/nginx/sites-available/adobe2api-plus-loopback.conf`
- `/etc/nginx/sites-enabled/adobe2api-plus-loopback.conf`
- `/etc/nginx/sites-available/adobe2api.aimasker.com.conf`
- `/etc/nginx/sites-enabled/adobe2api.aimasker.com.conf`

The loopback listener proxies `127.0.0.1:8300` to the fixed internal Web address. The TLS virtual host proxies to that loopback listener and includes 128 MiB upload allowance, 3600-second long-request timeouts, disabled request/response buffering, WebSocket upgrade headers, real client IP overwrite for a DNS-only origin, HSTS, frame/content/referrer/permissions/CSP headers and hidden `X-Powered-By`. Every change passed `nginx -t`; Nginx was reloaded, not restarted.

## Initial deployment and verification sequence

1. Snapshot Sub2API containers, ports, networks, volumes, resources, Nginx hash and public status.
2. Pin MySQL by registry digest and download the immutable CI release archive.
3. Verify release SHA-256 and internal checksums; load, but do not run, mint.
4. Generate strong random values into the ignored local private file and install the server environment as mode `0600`.
5. Validate Compose default services are exactly MySQL and Web; create only the internal backend network and named volumes.
6. Start MySQL/Web, wait for health, perform one server-side administrator bootstrap, and verify cookie flags without printing credentials.
7. Stop/start only this project's MySQL/Web, verify health and persisted counts.
8. Install Nginx candidates, run `nginx -t`, enable, run `nginx -t`, and reload Nginx only.
9. Create or verify only the exact Cloudflare A record; refuse conflicting records.
10. Verify login/static files, health, HTTPS/certificate, security headers and unauthenticated rejection. Do not send generation requests with valid credentials.
11. Recheck Sub2API and existing sites against the timestamped baseline.

## Upstream profile — explicit approval required

Do not run the following during the safe deployment:

```sh
sudo docker compose \
  --env-file /opt/adobe2api-plus/private/.env \
  -f /opt/adobe2api-plus/deploy/kr/docker-compose.yml \
  --profile upstream up -d mint worker
```

The Worker's first periodic loop can request a Sherlock token; mint then opens Adobe Firefly and loads the Adobe Sherlock SDK. Enabling this profile creates the project egress network and causes upstream access even with no Adobe account imported. It therefore requires explicit user approval and a fresh resource check.

## Upgrade flow

Use this sequence and never auto-overwrite AIMasker deployment customization:

```text
fetch upstream -> review differences -> local/CI tests -> merge -> package fixed linux/amd64 images -> snapshot -> deploy only this project -> verify -> publish receipt
```

Keep source, KR templates and project-specific docs in `lecview/adobe2api-plus`. Keep only a sanitized cross-project deployment summary in `lecview/aimasker-sub2api`.

