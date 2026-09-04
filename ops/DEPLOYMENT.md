# KR deployment release record

Last updated: 2026-09-04 (Asia/Shanghai).

## Immutable artifacts

- Source/deployment commit: `5a0134f723fd70fb5685131677affbf09e7708da`.
- Pull request: `https://github.com/lecview/adobe2api-plus/pull/1`.
- Successful linux/amd64 workflow: `https://github.com/lecview/adobe2api-plus/actions/runs/33884343710`.
- Release: `https://github.com/lecview/adobe2api-plus/releases/tag/deployment-5a0134f723fd70fb5685131677affbf09e7708da`.
- Archive SHA-256: `2e934d7e77026d374c051ac180f81d6315d329c708bd5f12f3c43bb732169829`.
- CI OCI config digests: Web `sha256:42f7074d46ffe6ffe5c667197a11f62237d4c034b246d1ecb4bc057687ab0dbc`; mint `sha256:04e13da2d0b92f5651f67fe1593e2f3b2386269242b662225724f3ef5b0d2278`.

The release archive and internal checksum manifest were verified before loading. Production did not build images. CI passed lint, typecheck, migration/integration coverage, tests, the production high-severity dependency audit, production build and isolated Compose expansion.

## Verified result

- Web/Worker health and independent restart recovery passed.
- HTTPS login, static assets and health endpoints returned 200.
- Unauthenticated model and generation endpoints returned 401.
- Authenticated model listing returned exactly the 13 documented families.
- An invalid ratio returned `400 / invalid_aspect_ratio` without queueing or upstream access.
- Remote-URL mode was enabled and no real generation was submitted for this validation.
- Resource and rotated-log limits remain enforced for Web, Worker, MySQL and mint.

## Upgrade and rollback policy

```text
fetch upstream -> review differences -> local/CI tests -> merge -> package fixed linux/amd64 images -> snapshot -> deploy only this project -> verify -> publish receipt
```

Rollback only the independent application image. Preserve database and media volumes, and never restart or modify Sub2API. Exact private paths, backup locations and commands are maintained in the restricted local operations workspace, not in GitHub.
