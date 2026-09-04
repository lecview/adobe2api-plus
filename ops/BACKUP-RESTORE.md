# Backup, restore and rollback

Last updated: 2026-09-04 (Asia/Shanghai).

## Backup scope

Before each deployment, create a timestamped directory under local `adobe2api-plus/backups/` and server `/opt/adobe2api-plus/backups/`. Capture only:

- Sub2API and host baseline metadata (container/image/health, ports, networks, volumes, resources and public HTTP status), without environment values;
- current DNS response and the exact `adobe2api.aimasker.com` record object, if any;
- Nginx candidate/current files that this project will add or change;
- deployment templates, fixed source/CI commit, image digests and archive checksum;
- sanitized Compose expansion and post-deployment container inspect output.

Production `.env`, databases, Docker volume contents, account data, tokens, cookies, logs, generated media and unredacted responses must not enter GitHub. Database/volume backups, when authorized, stay in the project backup area with restricted permissions.

## Default rollback (new service only)

1. In `/opt/adobe2api-plus`, run `docker compose stop web worker mint mysql`. Do not use `down -v`.
2. Leave `${COMPOSE_PROJECT_NAME}_mysql-data` and `${COMPOSE_PROJECT_NAME}_generated-media` intact by default.
3. Remove only `/etc/nginx/sites-enabled/adobe2api.aimasker.com` and the independent adobe2api WebSocket map file created by this project. Keep the reviewed files in `/opt/adobe2api-plus/deploy/nginx` and the timestamped backup.
4. Run `sudo nginx -t`; only if it passes, reload Nginx. Never restart or reload Sub2API.
5. Decide separately whether rollback requires deleting `adobe2api.aimasker.com`. If deletion is required, use the saved record ID and verify the record still matches this project first. Do not modify any other hostname.
6. Recheck Sub2API's three containers, `127.0.0.1:8081`, `/health`, `aimasker.com` and `api.aimasker.com` against the pre-deployment baseline.

## Application/image rollback

To roll back only application code, keep MySQL/media volumes and `.env`, load the previously retained image archive, change only `WEB_IMAGE`/`MINT_IMAGE` to the recorded prior tags, run `docker compose config --quiet`, and recreate only this project's containers. Database migrations are forward-only; before deploying a commit with schema changes, confirm compatibility or make an authorized MySQL logical backup and restore rehearsal.

## Data restore

Data restore is never part of the default rollback. It requires a separate authorization covering downtime and acceptable data loss. Validate archive checksums, image/schema compatibility and restore into an isolated database first. Never point adobe2api-plus at Sub2API PostgreSQL or Redis, and never restore these MySQL/media volumes over any Sub2API path.
