# adobe2api-plus / KR handoff

Last updated: 2026-09-04 (Asia/Shanghai).

## Current release

- `adobe2api-plus` is an independent service and is not a Sub2API component.
- Public endpoint: `https://adobe2api.aimasker.com`.
- Deployed source/image commit: `5a0134f723fd70fb5685131677affbf09e7708da`.
- CI run `33884343710` and immutable release `deployment-5a0134f723fd70fb5685131677affbf09e7708da` succeeded.
- Web, Worker, MySQL and mint were healthy after deployment. Only this project's Web and Worker were recreated for the release.

## Function delivered

- `/v1/models` exposes exactly 13 media families rather than resolution/aspect-ratio variants.
- Resolution, ratio, duration, video resolution and audio are request parameters. Routing records both the requested family and internal resolved model.
- Production remote-URL mode is enabled: successful upstream media URLs are returned without downloading result media locally.
- Authenticated production validation returned all 13 families. Invalid parameter combinations failed with HTTP 400 before queueing or upstream access.
- No paid or real generation request was submitted for deployment validation.

## Security and rollback

- Runtime credentials, account data, logs, backups and media remain outside GitHub.
- The service retains its independent project, containers, networks, volumes, database and proxy configuration.
- Application rollback changes only this project's Web/Worker image and preserves its database/media volumes. It must not restart, roll back or delete Sub2API components.
- Detailed host topology, private paths, backup locations and operational commands remain only in the restricted local operations workspace.
