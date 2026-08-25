# adobe2api-plus

> This project is a **Next.js (App Router) + TypeScript** rewrite of [adobe2api](https://github.com/leik1000/adobe2api). Thanks to the original author [leik1000](https://github.com/leik1000) and all its contributors.

An Adobe Firefly / OpenAI-compatible gateway service, built with **Next.js (App Router) + TypeScript**.

Current design:

- Unified entry point: `/v1/chat/completions` (image + video)
- Image-specific endpoints: `/v1/images/generations`, `/v1/images/edits`
- Video-specific endpoint: `/v1/video/generations` (asynchronous tasks)
- Adobe account pool management (manual tokens + automatic cookie refresh)
- Admin web UI: accounts / jobs / proxy pool / system settings
- A standalone worker process for durable tasks and token refresh

---

## How We Solved 408 (Risk Control)

Adobe Firefly's third-party model endpoint (`firefly-3p.ff.adobe.io`, serving GPT / Flux / Gemini and others) returns `408` ("system under load") when an account is risk-flagged. Extensive testing proved this `408` is **not actual overload, but account-level risk flagging**:

1. **Root cause**: 408 is independent of the request body, fingerprint quality, token structure, cookie, and proxy IP — the only decisive factor is whether the account is flagged upstream. Bulk-registered pool accounts (low security rating `MedSecNoEV,LowSec`) are broadly flagged, while clean accounts (normal registration / real usage history) pass without issue.

Measured sherlockToken matrix (minting mode × minting IP type → token quality):

| Minting mode | Minting IP type | Token quality |
|---|---|---|
| HEADED | Any (direct / datacenter OK) | Good |
| HEADLESS + residential proxy | Residential | Medium |
| HEADLESS + direct / datacenter | Datacenter | Bad |
| No arp / forged arp | — | None |

> Headful minting is required to produce a "Good" token — that's why the built-in mint service defaults to HEADED.

2. **Handling strategy**:
   - **408 → remint sherlockToken, then retry**: on a 408 (`timeout_error`), the account is no longer risk-flagged — instead the global sherlockToken is force-reminted immediately (a fresh browser environment, i.e. a brand-new token) and the submission is retried on the same account (up to 3 attempts). Every remint and retry is recorded in the job's **event log** (`SHERLOCK_REMINT` events).
   - **401 → delete outright**: a 401 means the token is invalid, so the account is deleted (job history is preserved via snapshots), clearly distinguished from 408.

3. **sherlockToken (`x-arp-session-id`)**: maintains the browser session state, minted by the built-in [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) mint service (headful + Xvfb) or entered manually, auto-refreshed by the worker on a fixed interval (default 5 minutes), and automatically used by the submission pipeline.

> Therefore: **account supply is the only bottleneck** — whether the third-party model endpoint works depends on whether the account is flagged, so clean accounts are required.

> 🎁 sherlockToken is minted automatically by the built-in fingerprint-chromium service — zero-config with Docker one-click deployment.

---

## Table of Contents

- [1. Deployment](#1-deployment)
- [2. Service Authentication](#2-service-authentication)
- [3. External API](#3-external-api)
- [4. Account / Credential Import](#4-account--credential-import)
- [5. Admin Console](#5-admin-console)
- [6. Storage](#6-storage)
- [7. Environment Variables](#7-environment-variables)
- [8. Tech Stack](#8-tech-stack)

---

## 1. Deployment

### Docker one-click deployment (recommended)

Prerequisite: an **x86_64 Linux server** (fingerprint-chromium ships x86_64 binaries only) with [Docker](https://www.docker.com/) and Docker Compose installed. Apple Silicon works via Docker Desktop for local trials (amd64 emulation runs but mints slower — not recommended for production).

1. **Clone the repository**:

```bash
git clone https://github.com/songsongQAQ/adobe2api-plus.git
cd adobe2api-plus
```

2. **Build and start everything in one command** (zero-config, works out of the box — pulls MySQL 8, creates database and tables, starts Web + Worker):

```bash
docker compose up -d --build
```

3. **sherlockToken minting flow (built-in fingerprint-chromium, no Roxy browser needed)**:

- **Docker one-click deployment (automatic, zero config)**: the built-in `mint` container (fingerprint-chromium 148 + Xvfb, headful) mints tokens; the worker automatically mints a fresh token via mint every 5 minutes and stores it globally — the submission pipeline always carries the latest value, with no external dependencies.
- **Local development (automatic)**: set `FP_CHROME_BIN` in `.env.development` (start fingerprint-chromium in-process) or `SHERLOCK_MINT_API` (connect to a self-hosted / remote mint service).
- **Manual entry (fallback)**: when no minting engine is configured, paste a manually obtained token on the admin "sherlock" page — other features are unaffected. How to get one: run this in the browser console while logged into `firefly.adobe.com`:
  ```js
  copy(document.cookie.match(/(?:^|;\s*)sherlockToken=([^;]+)/)?.[1] ?? "")
  ```

4. **Access the admin console**:

- URL: `http://127.0.0.1:3000/login`
- Username: `admin`
- Password: `admin`

> - **Default admin credentials are `admin` / `admin`** (auto-created on first start) — **change them in production**.
> - Secrets (`SESSION_SECRET` / `ENCRYPTION_KEY`) ship with built-in defaults, so it works out of the box. In production, create a `.env` to override them: `cp .env.example .env`, then generate your own with `openssl rand -hex 32` (session) and `openssl rand -hex 16` (encryption).
> - MySQL 8 starts automatically with compose; tables are migrated automatically on first start — **no manual `db:push` needed**.
> - Persistence: MySQL data in the `mysql-data` volume, generated media in the `generated-media` volume.
> - Status / logs: `docker compose ps`, `docker compose logs -f web worker`.
> - Default database credentials are `adobe / adobe` (database `adobe`); override via `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` in `.env`.

### Local development

Prerequisites: Node.js 20+, MySQL 8.x (or MariaDB 10.x).

1. **Install dependencies**:

```bash
npm install
```

2. **Prepare environment variables**:

```bash
cp .env.example .env.development
# Edit .env.development with your database connection, secrets, and initial admin account
```

3. **Start the web service**:

```bash
npm run dev
```

4. **Start the worker in a separate process** (runs Adobe jobs and token refresh):

```bash
npm run worker
```

5. **Open the admin console**:

- URL: `http://127.0.0.1:3000/login`
- The initial admin account is set by `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`
- Change it under "System Settings → Account & Security" after login

### Database initialization

Tables are mapped by the Drizzle schema (`src/lib/db/schema.ts`):

```bash
npm run db:push        # sync the schema to the database
npm run db:generate    # generate migration files (only when intentionally changing the schema)
```

---

## 2. Service Authentication

Create a service API key under "System Settings → Account & Security" in the admin console. It is **shown only once** after creation — save it immediately.

Use one of the following to call the external API:

- `Authorization: Bearer <api_key>`
- `X-API-Key: <api_key>`

> API keys are prefixed with `adobe_`. The admin console and admin API require logging in via `/api/auth/login` and holding a session cookie — independent from the external generation API authentication.

---

## 3. External API

### 3.0 Supported model families

Model IDs follow `{family}-{resolution}-{ratio}` or `{family}-{duration}s-{ratio}-{resolution}`. For backward compatibility with older `adobe2api` callers, IDs with a `firefly-` prefix are also accepted (normalized automatically).

#### Image models

Nano Banana / Nano Banana Pro (upstream `nano-banana-2`):

- Naming: `nano-banana-{res}-{ratio}` / `nano-banana-pro-{res}-{ratio}`
- Resolutions: `1k` / `2k` / `4k`
- Ratio suffixes: `1x1` / `16x9` / `9x16` / `4x3` / `3x4` / `5x4` / `4x5` / `3x2` / `2x3` / `21x9`
- Examples: `nano-banana-pro-2k-16x9`, `nano-banana-4k-1x1`

Nano Banana 2 (upstream `nano-banana-3`):

- Naming: `nano-banana2-{res}-{ratio}`
- Resolutions: `1k` / `2k` / `4k`
- Extra ultra-tall/wide ratios: `1x8` / `1x4` / `4x1` / `8x1`
- Examples: `nano-banana2-2k-16x9`, `nano-banana2-2k-1x8`

GPT Image (upstream `gpt-image`, version `2`):

- Naming: `gpt-image-{res}-{ratio}`
- Resolutions: `1k` / `2k` / `4k`
- Examples: `gpt-image-2k-16x9`, `gpt-image-4k-1x1`

> `aspect_ratio=auto` is **not supported**; passing `auto` falls back to `1:1`. Pass an explicit ratio or use a model ID with a ratio suffix. The default model is `nano-banana-pro-2k-16x9`.

#### Video models

Sora2 / Sora2 Pro:

- Naming: `sora2-{dur}s-{ratio}` / `sora2-pro-{dur}s-{ratio}`
- Durations: `4s` / `8s` / `12s`; ratios: `9x16` / `16x9`
- Examples: `sora2-4s-16x9`, `sora2-pro-8s-9x16`

Veo31 (frame mode):

- Naming: `veo31-{dur}s-{ratio}-{res}`
- Durations: `4s` / `6s` / `8s`; ratios: `16x9` / `9x16`; resolutions: `720p` / `1080p`
- 1 reference image = first frame; 2 = first + last frame
- Example: `veo31-4s-16x9-1080p`

Veo31 Ref (reference-image mode):

- Naming: `veo31-ref-{dur}s-{ratio}-{res}`
- Up to 3 reference images
- Example: `veo31-ref-6s-9x16-720p`

Gemini Omni:

- Naming: `gemini-omni-{dur}s-{ratio}-{res}`
- Durations: `4s` / `6s` / `8s` / `10s`; resolutions: `720p` / `1080p`
- Up to 4 image references (style) + 1 video reference (source)
- Compatible IDs without a resolution default to `720p`
- Example: `gemini-omni-10s-16x9-1080p`

Kling 3.0:

- Naming: `kling3-{dur}s-{ratio}-{res}`
- Durations: `5s` / `10s` / `15s`; ratios: `16x9` / `9x16`
- 1 image = first frame, 2 = first + last frame; audio enabled by default
- Compatible IDs without a resolution default to `720p`
- Examples: `kling3-5s-16x9-720p`, `kling3-15s-9x16`

Kling O3:

- Naming: `kling-o3-{dur}s-{ratio}-{res}`
- Durations: `5s` / `15s`; resolutions: `720p` / `1080p`
- Supports referencing created entities via `@entity:name`
- Compatible IDs without a resolution default to `1080p`
- Example: `kling-o3-5s-16x9`

Seedance 2.0 / 2.0 Fast:

- Naming: `seedance20-{dur}s-{ratio}-{res}` / `seedance20-fast-{dur}s-{ratio}-{res}`
- Durations: `4s` ~ `15s`; ratios: `21x9` / `16x9` / `4x3` / `1x1` / `3x4` / `9x16`; resolutions: `480p` / `720p` / `1080p`
- Up to 9 images (style) + 3 videos (source) + 3 audios (source), 12 items total
- Audio references must be paired with at least 1 image or 1 video; audio enabled by default
- Examples: `seedance20-4s-16x9-480p`, `seedance20-fast-15s-9x16-1080p`

### 3.1 List models

```bash
curl -X GET "http://127.0.0.1:3000/v1/models" \
  -H "Authorization: Bearer <service_api_key>"
```

The set of publicly visible models can be configured in the admin console.

### 3.2 Unified entry point: `/v1/chat/completions`

Text-to-image:

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro-2k-16x9",
    "messages": [{"role":"user","content":"a cinematic mountain sunrise"}]
  }'
```

Image-to-image (pass the image in the latest user message):

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro-2k-16x9",
    "messages": [{
      "role":"user",
      "content":[
        {"type":"text","text":"turn this photo into watercolor style"},
        {"type":"image_url","image_url":{"url":"https://example.com/input.jpg"}}
      ]
    }]
  }'
```

Text-to-video:

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sora2-4s-16x9",
    "messages": [{"role":"user","content":"a drone shot over snowy forest"}]
  }'
```

Image-to-video:

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sora2-8s-9x16",
    "messages": [{
      "role":"user",
      "content":[
        {"type":"text","text":"animate this character walking forward"},
        {"type":"image_url","image_url":{"url":"https://example.com/character.png"}}
      ]
    }]
  }'
```

Gemini Omni video reference (pass the video in the latest user message):

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-omni-10s-16x9-1080p",
    "messages": [{
      "role":"user",
      "content":[
        {"type":"text","text":"continue this scene with a smooth camera move"},
        {"type":"video_url","video_url":{"url":"https://example.com/reference.mp4"}}
      ]
    }]
  }'
```

Set `"stream": true` in the request to receive generation progress as a server-sent event stream.

### 3.3 Image generation: `/v1/images/generations`

```bash
curl -X POST "http://127.0.0.1:3000/v1/images/generations" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro-4k-16x9",
    "prompt": "futuristic city skyline at dusk"
  }'
```

### 3.4 Image editing: `/v1/images/edits`

Edit an image based on a prompt:

```bash
curl -X POST "http://127.0.0.1:3000/v1/images/edits" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro-2k-1x1",
    "prompt": "replace the background with a beach",
    "image": "https://example.com/input.jpg"
  }'
```

### 3.5 Video generation: `/v1/video/generations` (async)

Text-to-video uses asynchronous tasks. Submitting returns a `task_id`; poll for the result:

```bash
curl -X POST "http://127.0.0.1:3000/v1/video/generations" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kling3-5s-16x9-720p",
    "prompt": "a cat walking in a neon city"
  }'
```

```bash
curl -X GET "http://127.0.0.1:3000/v1/video/generations/<task_id>" \
  -H "Authorization: Bearer <service_api_key>"
```

### 3.6 Entity creation and Kling references

Entities keep a character or object consistent in Kling O3. An entity is bound to the Adobe account that created it; the service resolves that account's Creative Cloud repository automatically.

Create an entity:

```bash
curl -X POST "http://127.0.0.1:3000/v1/entities" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PinkWarrior",
    "type": "character",
    "description": "A pink-haired warrior woman in futuristic armor.",
    "images": [
      "data:image/png;base64,<base64_image>"
    ]
  }'
```

- `name`: entity name, referenced later via `@entity:name`; do not include `@`
- `type`: `character` / `object` / `location`
- `description`: entity description
- `images`: 1 to 4 images, supporting `data:image/...;base64,...` or plain base64

List locally bound entities:

```bash
curl -X GET "http://127.0.0.1:3000/v1/entities" \
  -H "Authorization: Bearer <service_api_key>"
```

Reference an entity in Kling O3:

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kling-o3-5s-16x9",
    "messages": [{
      "role": "user",
      "content": "A cinematic shot of @entity:PinkWarrior walking through a neon city."
    }]
  }'
```

---

## 4. Account / Credential Import

Adobe account credentials (token, cookie, `ims_sid`) are used to request generation from Adobe Firefly and support automatic cookie refresh.

### Method A: upload in the admin console (recommended)

1. Open and log in to the admin console
2. Go to the "Accounts" page
3. Click "Batch Import" and upload a JSON file or paste content
4. Supported structures: `{users:[...]}`, `{accounts:[...]}`, or a top-level array
5. Per-account fields: `token`, `cookie`, `ims_sid`, `email`, `display_name`, `account_id`, credit fields, etc.
6. After import, run "Refresh Credits" on accounts that carry cookies

> Imported content is stored encrypted; `source_host` / `password` are only read for compatibility — configure proxies under "Proxy Pool".

### Method B: add a single account manually

On the "Accounts" page, fill in a single account's `token` / `cookie` / `ims_sid` and credit fields, then save.

---

## 5. Admin Console

After login, the following pages are available:

| Page | Function |
|------|----------|
| Overview | Runtime status overview |
| Accounts | Adobe account / token management (batch import, refresh credits, export cookies, risk-control release) |
| Jobs | Generation task queue and status |
| Proxy Pool | Proxy node management for distributing request egress |
| System Settings | Four configuration groups (see below) |

"System Settings" tabs:

- **Account & Security**: admin account, service API keys, public URL, publicly visible models
- **Proxy & Network**: proxy pool toggle, image/video generation timeouts
- **Retry & Fault Tolerance**: auto retry, max attempts, backoff, retryable status codes, account rotation strategy
- **Refresh & Storage**: token refresh interval and concurrency, per-account max concurrency, media capacity and prune thresholds

---

## 6. Storage

- Generated media: `data/generated/` (default, override with `MEDIA_ROOT`)
- Public access prefix: `/generated/` (default, override with `MEDIA_PUBLIC_PREFIX`)
- MySQL is the only source of truth at runtime: accounts, tokens, jobs, media assets, and system settings are all persisted there

Media retention policy:

- Capacity-based automatic cleanup (oldest first): `generated_max_size_mb`, `generated_prune_size_mb` (configured under "System Settings → Refresh & Storage")
- When the limit is exceeded, old files are deleted until the total size drops back under the threshold

---

## 7. Environment Variables

The web and worker processes validate their configuration up front (`validateRuntime`); a missing critical value fails before listening rather than on the first request.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Local dev ✅ / Docker auto | MySQL connection string (`mysql:` scheme, includes a database name) |
| `SESSION_SECRET` | Docker built-in default | Session signing secret (≥32 bytes) |
| `ENCRYPTION_KEY` | Docker built-in default | Credential encryption key (≥16 bytes) |
| `ADMIN_BOOTSTRAP_USERNAME` | default `admin` | Initial admin account (auto-created on first start) |
| `ADMIN_BOOTSTRAP_PASSWORD` | default `admin` | Initial admin password |

> All other settings (media directory, Adobe upstream URL, token refresh interval, media retention, proxy pool, etc.) are configurable in the admin console under **System Settings** — no environment variables needed.
>
> Automatic sherlockToken minting variables (`SHERLOCK_MINT_API` / `FP_CHROME_BIN`, etc.) are listed in `.env.example`; Docker one-click deployment needs none (built-in mint container); if unset, you can enter the token manually in the admin console.

---

## 8. Tech Stack

- Next.js (App Router)
- TypeScript
- Drizzle ORM + MySQL
- React + Tailwind CSS + Radix UI
- Standalone worker process (durable job queue, token refresh)
- Vitest (unit + integration tests)
