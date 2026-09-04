# Backup, restore and rollback

Last updated: 2026-09-04 13:56 (Asia/Shanghai).

## Recorded deployment backups

- Local pre-deployment evidence: `E:\APP\codex\主机维护\KR主机\adobe2api-plus\backups\kr-predeploy-20260904-121508`.
- Server pre-deployment evidence: `/opt/adobe2api-plus/backups/kr-predeploy-20260904-121508`.
- Internal-network correction and before/after Compose files: `/opt/adobe2api-plus/backups/internal-network-fix-20260904-134659`.
- Nginx target-absence marker and pre-security-header-fix site: `/opt/adobe2api-plus/backups/nginx-install-20260904-134815`.
- DNS pre-operation response: `/opt/adobe2api-plus/backups/adobe2api.aimasker.com-before-create-20260904T055308Z.json` (mode `0600`).

Backups contain sanitized status/configuration evidence only. Production `.env`, database/volume contents, account data, session values, Tokens, Cookies, logs, generated media and unredacted API responses are not GitHub material.

## Exact default rollback — new service only

The following stops only the new Compose project and leaves both data volumes intact:

```sh
cd /opt/adobe2api-plus/deploy/kr
sudo docker compose \
  --env-file /opt/adobe2api-plus/private/.env \
  -f docker-compose.yml \
  --profile upstream stop worker mint web mysql
```

Disable only this project's active Nginx files. Keep the reviewed `sites-available` files and project templates for diagnosis:

```sh
sudo rm -f /etc/nginx/sites-enabled/adobe2api.aimasker.com.conf
sudo rm -f /etc/nginx/sites-enabled/adobe2api-plus-loopback.conf
sudo rm -f /etc/nginx/conf.d/adobe2api-plus-websocket-map.conf
sudo nginx -t
sudo systemctl reload nginx
```

Do not use `docker compose down -v`. Do not remove these volumes unless a separate destructive-data authorization is given:

```text
aimasker-adobe2api-plus_mysql-data
aimasker-adobe2api-plus_generated-media
```

DNS rollback is independent. Delete `adobe2api.aimasker.com` only if the rollback objective requires it, after re-reading the saved Cloudflare response and verifying the live record is still the unproxied A record to `43.128.140.43`. Never alter `aimasker.com`, `api.aimasker.com`, `imgs.aimasker.com` or any other record.

After rollback, verify Sub2API still has three healthy containers, Web still binds `127.0.0.1:8081`, `/health` returns 200, and the enabled Sub2API Nginx file hash remains the recorded baseline. Nginx reload is shared configuration activation; it is not a Sub2API container restart.

## Application image rollback

Keep the `.env`, MySQL/media volumes and independent Nginx files. Load the retained earlier image archive, change only `WEB_IMAGE` and `MINT_IMAGE` in the server private environment, verify the archive/config, then recreate only this Compose project's Web (and Worker/mint only if they had been separately approved). Database migrations are forward-only; confirm compatibility before image rollback.

## Data restore

Data restore is not part of the default rollback. It requires separate authorization covering downtime and acceptable data loss. Validate checksums and schema compatibility, restore first into an isolated MySQL instance, and never point adobe2api-plus at Sub2API PostgreSQL, Redis, network, volumes or paths.

