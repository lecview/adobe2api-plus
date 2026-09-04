# adobe2api-plus / KR handoff

Last updated: 2026-09-04 (Asia/Shanghai).

## Scope and status

- Service: `adobe2api-plus`, independent from Sub2API.
- Public hostname: `adobe2api.aimasker.com` only.
- Server root: `/opt/adobe2api-plus`.
- Local task root: `E:\APP\codex\主机维护\KR主机\adobe2api-plus`.
- Upstream source pin: `011813639b99a51f0e16d8e51481147c578d102c`; source tree `866ccc5eb6ea08a855f06b1d789fa751b2766afd`.
- At audit time, the `lecview` Fork and `songsongQAQ` upstream were identical at that commit.
- Deployment receipt, final image digests, port, DNS record ID, backups and verification results are recorded after rollout in `DEPLOYMENT.md`.

## Safety boundary

The default KR Compose start is `mysql` + `web` only. `worker` and `mint` are under the explicit `upstream` profile because the first worker periodic loop enables sherlock refresh by default and invokes mint; mint then loads Adobe Firefly and the Sherlock SDK. Do not start the `upstream` profile until this upstream access is explicitly approved.

No Adobe account, token, cookie or service API key is imported by deployment. Production secrets exist only in `/opt/adobe2api-plus/.env` and the matching local `private/` file; neither location is committed.

## Isolation contract

- Compose project: `aimasker-adobe2api-plus`.
- Containers, networks and volumes use the same unique prefix.
- Web binds only `127.0.0.1:${WEB_PORT}:3000`.
- MySQL and mint have no host port.
- Sub2API's PostgreSQL, Redis, network, volumes, configuration, containers and `127.0.0.1:8081` are never referenced.
- Nginx uses a separate site and a separate WebSocket map variable.

Read `DEPLOYMENT.md` for deployment/upgrade checks and `BACKUP-RESTORE.md` before rollback or restore.
