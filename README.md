# adobe2api-plus

> English README: [`README_EN.md`](README_EN.md)

> 本项目基于 [adobe2api](https://github.com/leik1000/adobe2api) 用 **Next.js（App Router）+ TypeScript** 重写，感谢原作者 [leik1000](https://github.com/leik1000) 及该项目的所有贡献者。

Adobe Firefly / OpenAI 兼容网关服务，基于 **Next.js（App Router）+ TypeScript** 构建。

当前设计：

- 对外统一入口：`/v1/chat/completions`（图像 + 视频）
- 图像专用接口：`/v1/images/generations`、`/v1/images/edits`
- 视频专用接口：`/v1/video/generations`（异步任务）
- Adobe 账号池管理（手动 Token + Cookie 自动刷新）
- 管理后台 Web UI：账号 / 任务 / 代理池 / 系统设置
- 独立 Worker 进程执行持久化任务与 Token 刷新

---

## 408 风控解决原理

Adobe Firefly 的第三方模型端点（`firefly-3p.ff.adobe.io`，承载 GPT / Flux / Gemini 等）在提交环境不达标时返回 `408`（「system under load」）。实测证明这个 `408` **并非真正的高负载，也并非账号被标记，而是对提交环境的判定结果**：

1. **根因**：408 的开关变量是**提交环境**——即 sherlockToken 质量（由铸造方式 × 铸造 IP 决定），与账号标记无关。环境不达标（HEADLESS、数据中心出口、无 arp / 伪造 arp）→ 恒定 408；有头铸造产出「好」token 之后才会进入正常的账号判定环节。

sherlockToken 实测矩阵（铸造方式 × 铸造 IP 类型 → token 质量）：

| 铸造方式 | 铸造 IP 类型 | token 质量 |
|---|---|---|
| HEADED（有头） | 任意（直连数据中心也行） | 好 |
| HEADLESS + 住宅代理 | 住宅 | 中 |
| HEADLESS + 直连/数据中心 | 数据中心 | 坏 |
| 无 arp / 伪造 arp | — | 无 |

> 有头铸造是产出「好」token 的必要条件，因此内置 mint 服务默认 HEADED。

2. **处理策略**：
   - **408 → 自动重铸 sherlockToken 后重试**：提交遇到 408（`timeout_error`）时，不再标记账号风控，立即强制重铸全局 sherlockToken（全新浏览器环境，等同一枚新 token），同账号自动重试（最多 3 次）。每次重铸与重试都会记录在任务的**操作记录**里（`SHERLOCK_REMINT` 事件）。
   - **401 → 彻底删除**：401 表示 token 已失效，直接删除账号（任务历史靠快照保留），与 408 明确区分。

3. **sherlockToken（`x-arp-session-id`）**：维护浏览器会话态，通过内置 [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) 铸造服务（headful + Xvfb）自动铸造或手动输入，由 worker 按固定周期（默认 5 分钟）自动刷新，提交链路自动使用最新 token。

> sherlockToken 可由内置 fingerprint-chromium 铸造服务维护；该能力需要显式启用 `upstream` profile，并会访问 Adobe。

---

## 目录

- [1. 部署方式](#1-部署方式)
- [2. 服务鉴权](#2-服务鉴权)
- [3. 外部 API 使用](#3-外部-api-使用)
- [4. 账号 / 凭据导入](#4-账号--凭据导入)
- [5. 管理后台](#5-管理后台)
- [6. 存储路径](#6-存储路径)
- [7. 环境变量配置](#7-环境变量配置)
- [8. 技术栈](#8-技术栈)

---

## 1. 部署方式

### Docker 一键部署（推荐）

前置：一台 **x86_64 Linux 服务器**（内置铸造用的 fingerprint-chromium 仅发布 x86_64 二进制）并安装好 [Docker](https://www.docker.com/) 与 Docker Compose。Apple Silicon 机器可用 Docker Desktop 本地体验（amd64 模拟能跑但铸造较慢，不建议做生产环境）。

1. **克隆项目**：

```bash
git clone https://github.com/songsongQAQ/adobe2api-plus.git
cd adobe2api-plus
```

2. **生成部署密钥并填写 `.env`**：

```bash
cp .env.example .env
# 填写全部必填变量；SESSION_SECRET/ENCRYPTION_KEY 可分别用 openssl rand -hex 32 生成
```

3. **构建并启动 Web + MySQL**（默认不启动会访问 Adobe 的 Worker/mint）：

```bash
docker compose up -d --build
```

4. **sherlockToken 铸造流程（内置 fingerprint-chromium）**：

- **Docker 显式启用**：获得上游访问授权后运行 `docker compose --profile upstream up -d --build mint worker`。内置 `mint` 容器使用 fingerprint-chromium 148 + Xvfb；worker 默认每 5 分钟向 mint 请求新 token，这会访问 Adobe。
- **本地开发（自动）**：`.env.development` 设置 `FP_CHROME_BIN`（本进程直启 fingerprint-chromium 铸造）或 `SHERLOCK_MINT_API`（连接自建/远程 mint 铸造服务）。
- **手动输入（兜底）**：未配置任何铸造引擎时，在后台「sherlock」页粘贴手动获取的 token，不影响其它功能。获取方式：在已登录 `firefly.adobe.com` 的浏览器控制台执行：
  ```js
  copy(document.cookie.match(/(?:^|;\s*)sherlockToken=([^;]+)/)?.[1] ?? "")
  ```

5. **访问管理后台**：

- 地址：`http://127.0.0.1:${WEB_PORT:-3000}/login`
- 账号和密码：使用 `.env` 中自行设置的 `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`

> - 不再提供默认管理员、会话密钥、加密密钥或 MySQL 密码；变量缺失时 Compose 会拒绝启动。
> - 数据库（MySQL 8）随 compose 自动启动，表结构由应用首次启动时自动迁移，**无需手动 `db:push`**。
> - 数据持久化：MySQL 数据在 `mysql-data` 卷，生成媒体在 `generated-media` 卷。
> - 查看状态/日志：`docker compose ps`、`docker compose logs -f web worker`。

### 本地开发 / 运行

依赖：Node.js 20+、MySQL 8.x（或 MariaDB 10.x）。

1. **安装依赖**：

```bash
npm install
```

2. **准备环境变量**：

```bash
cp .env.example .env.development
# 编辑 .env.development，填入数据库连接、密钥、管理员初始账号
```

3. **启动 Web 服务**：

```bash
npm run dev
```

4. **另开进程启动 Worker**（执行 Adobe 任务与 Token 刷新）：

```bash
npm run worker
```

5. **访问管理后台**：

- 地址：`http://127.0.0.1:3000/login`
- 默认管理员账号由 `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` 决定
- 登录后可在「系统设置 → 账户与安全」修改

### 数据库初始化

数据库表由 Drizzle schema 映射（`src/lib/db/schema.ts`）：

```bash
npm run db:push        # 将 schema 同步到数据库
npm run db:generate    # 生成迁移文件（仅在刻意变更表结构时使用）
```

---

## 2. 服务鉴权

服务 API Key 在管理后台「系统设置 → 账户与安全」中创建，创建后**只显示一次**，请立即保存。

调用外部 API 时，使用以下任一方式：

- `Authorization: Bearer <api_key>`
- `X-API-Key: <api_key>`

> API Key 前缀为 `adobe_`。管理后台与管理 API 需要先通过 `/api/auth/login` 登录并持有会话 Cookie，与外部生成 API 的鉴权相互独立。

---

## 3. 外部 API 使用

### 3.0 支持的模型族

`/v1/models` 只返回 13 个稳定模型家族。比例、分辨率、时长、音频等能力通过请求参数选择；内部 `resolvedModel` 组合 ID 不属于公开 API。

#### 图像模型

- 家族：`gpt-image-2`、`nano-banana`、`nano-banana-pro`、`nano-banana2`
- `output_resolution`：`1K`、`2K`、`4K`
- `aspect_ratio`：`1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`5:4`、`4:5`、`3:2`、`2:3`、`21:9`；仅 `nano-banana2` 额外支持 `1:8`、`1:4`、`4:1`、`8:1`
- `quality`：`low` / `medium` / `high`，仅对应 Adobe detailLevel 1 / 3 / 5，不改变分辨率
- 默认：`gpt-image-2` 为 1K、16:9、high；其余为 2K、16:9、high
- `size` 必须是共享尺寸表中的精确尺寸，并同时决定比例和分辨率；它与显式参数冲突或任何参数不受支持时，在入队前返回 400

```json
{"model":"gpt-image-2","prompt":"futuristic city skyline at dusk","aspect_ratio":"16:9","output_resolution":"4K","quality":"high","response_format":"url"}
```

#### 视频模型

- `sora2` / `sora2-pro`：4/8/12 秒，16:9 或 9:16，不接受 `resolution`；默认 8 秒、16:9
- `veo31`：4/6/8 秒，16:9 或 9:16，720p/1080p；1 张图为首帧、2 张为首尾帧；默认 4 秒、16:9、720p
- `veo31-ref`：同上，最多 3 张参考图
- `gemini-omni`：4/6/8/10 秒，16:9 或 9:16，720p/1080p；最多 4 图 + 1 视频；默认 4 秒、16:9、720p
- `kling3`：5/10/15 秒，16:9 或 9:16，720p/1080p；最多 2 图，音频默认开启；默认 5 秒、16:9、720p
- `kling-o3`：5/15 秒，16:9 或 9:16，720p/1080p，保留实体引用；默认 5 秒、16:9、1080p
- `seedance20` / `seedance20-fast`：4–15 整数秒，21:9/16:9/4:3/1:1/3:4/9:16，480p/720p/1080p；最多 9 图、3 视频、3 音频且合计 12 项，音频参考须搭配视觉参考；默认 8 秒、16:9、720p，音频开启

```json
{"model":"seedance20-fast","prompt":"a cinematic tracking shot","duration":10,"aspect_ratio":"16:9","resolution":"1080p","generate_audio":true}
```

#### 旧调用兼容

旧组合 ID（包括 `firefly-` 前缀）继续接受，例如 `gpt-image-4k-4x3`、`sora2-8s-9x16`、`seedance20-fast-12s-9x16-1080p`。其中编码的参数是固定参数；显式参数冲突时返回 400。组合 ID 不会出现在 `/v1/models`，标准响应仍返回对应家族名。

### 3.1 获取模型列表

```bash
curl -X GET "http://127.0.0.1:3000/v1/models" \
  -H "Authorization: Bearer <service_api_key>"
```

管理后台「系统设置」中可配置对外可见的模型子集。

### 3.2 统一入口：`/v1/chat/completions`

文生图：

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro",
    "aspect_ratio": "16:9",
    "output_resolution": "2K",
    "messages": [{"role":"user","content":"a cinematic mountain sunrise"}]
  }'
```

图生图（在最新 user 消息中传入图片）：

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro",
    "aspect_ratio": "16:9",
    "output_resolution": "2K",
    "messages": [{
      "role":"user",
      "content":[
        {"type":"text","text":"turn this photo into watercolor style"},
        {"type":"image_url","image_url":{"url":"https://example.com/input.jpg"}}
      ]
    }]
  }'
```

文生视频：

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sora2",
    "duration": 4,
    "aspect_ratio": "16:9",
    "messages": [{"role":"user","content":"a drone shot over snowy forest"}]
  }'
```

图生视频：

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sora2",
    "duration": 8,
    "aspect_ratio": "9:16",
    "messages": [{
      "role":"user",
      "content":[
        {"type":"text","text":"animate this character walking forward"},
        {"type":"image_url","image_url":{"url":"https://example.com/character.png"}}
      ]
    }]
  }'
```

Gemini Omni 视频参考（在最新 user 消息中传入视频）：

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-omni",
    "duration": 10,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "messages": [{
      "role":"user",
      "content":[
        {"type":"text","text":"continue this scene with a smooth camera move"},
        {"type":"video_url","video_url":{"url":"https://example.com/reference.mp4"}}
      ]
    }]
  }'
```

支持在请求中设置 `"stream": true` 以 SSE 流式接收生成进度。

### 3.3 图像接口：`/v1/images/generations`

```bash
curl -X POST "http://127.0.0.1:3000/v1/images/generations" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro",
    "aspect_ratio": "16:9",
    "output_resolution": "4K",
    "prompt": "futuristic city skyline at dusk"
  }'
```

### 3.4 图像编辑：`/v1/images/edits`

在原图基础上按提示词编辑：

```bash
curl -X POST "http://127.0.0.1:3000/v1/images/edits" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro",
    "aspect_ratio": "1:1",
    "output_resolution": "2K",
    "prompt": "replace the background with a beach",
    "image": "https://example.com/input.jpg"
  }'
```

### 3.5 视频接口：`/v1/video/generations`（异步）

文生视频走异步任务，提交后返回 `task_id`，再轮询查询结果：

```bash
curl -X POST "http://127.0.0.1:3000/v1/video/generations" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kling3",
    "duration": 5,
    "aspect_ratio": "16:9",
    "resolution": "720p",
    "prompt": "a cat walking in a neon city"
  }'
```

```bash
curl -X GET "http://127.0.0.1:3000/v1/video/generations/<task_id>" \
  -H "Authorization: Bearer <service_api_key>"
```

### 3.6 实体创建与可灵（Kling）引用

实体用于 Kling O3 保持角色或物体一致。实体绑定到创建它的 Adobe 账号，服务会自动获取该账号的 Creative Cloud 仓库。

创建实体：

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

- `name`：实体名，后续在 prompt 中使用 `@entity:name` 引用；不要包含 `@`
- `type`：`character` / `object` / `location`
- `description`：实体特征描述
- `images`：1 到 4 张图片，支持 `data:image/...;base64,...` 或纯 base64

查看本地已绑定实体：

```bash
curl -X GET "http://127.0.0.1:3000/v1/entities" \
  -H "Authorization: Bearer <service_api_key>"
```

在 Kling O3 中引用实体：

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kling-o3",
    "duration": 5,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "messages": [{
      "role": "user",
      "content": "A cinematic shot of @entity:PinkWarrior walking through a neon city."
    }]
  }'
```

---

## 4. 账号 / 凭据导入

Adobe 账号凭据（Token、Cookie、`ims_sid`）用于向 Adobe Firefly 请求生成，并支持 Cookie 自动刷新。

### 方式 A：管理后台上传（推荐）

1. 访问并登录管理后台
2. 打开「账号」页
3. 点击「批量导入」，上传 JSON 文件或粘贴内容
4. 支持结构：`{users:[...]}`、`{accounts:[...]}` 或顶层数组
5. 每个账号支持字段：`token`、`cookie`、`ims_sid`、`email`、`display_name`、`account_id`、额度字段等
6. 导入完成后，可在列表中对带 Cookie 的账号执行「刷新积分」批量刷新

> 导入的内容仅加密保存；`source_host` / `password` 仅作兼容读取，代理请在「代理池」配置。

### 方式 B：手动单条添加

在「账号」页填写单个账号的 `token` / `cookie` / `ims_sid` 与额度字段后保存。

---

## 5. 管理后台

登录后提供以下页面：

| 页面 | 功能 |
|------|------|
| 概览 | 运行状态总览 |
| 账号 | Adobe 账号 / Token 管理（批量导入、刷新积分、导出 Cookie、风控解除） |
| 任务 | 生成任务队列与状态 |
| 代理池 | 代理节点管理，用于分散请求出口 |
| 系统设置 | 四类配置（见下） |

「系统设置」四页签：

- **账户与安全**：管理员账号、服务 API Key、公共 URL、对外可见模型
- **代理与网络**：代理池开关、图片/视频生成超时
- **重试与容错**：自动重试、最大尝试次数、退避、可重试状态码、账号轮换策略
- **刷新与存储**：Token 自动刷新间隔与并发、单账号最高并发、生成文件容量与清理阈值

---

## 6. 存储路径

- 生成媒体文件：`data/generated/`（默认，可由 `MEDIA_ROOT` 覆盖）
- 对外访问前缀：`/generated/`（默认，可由 `MEDIA_PUBLIC_PREFIX` 覆盖）
- 数据库（MySQL）是唯一运行时数据源：账号、Token、任务、媒体资产、系统设置均落库

生成媒体保留策略：

- 按容量阈值自动清理（最旧优先）：`generated_max_size_mb`、`generated_prune_size_mb`（在「系统设置 → 刷新与存储」配置）
- 超过上限时自动删除旧文件，直到总大小降回阈值以内

---

## 7. 环境变量配置

Web 与 Worker 在启动前会主动校验配置（`validateRuntime`），关键配置缺失会在监听前直接失败，而非延迟到首个请求。

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_URL` | 本地开发 ✅ / Docker 自动组合 | MySQL 连接串（`mysql:` 协议，含库名） |
| `SESSION_SECRET` | ✅ | 会话签名密钥（≥32 字节） |
| `ENCRYPTION_KEY` | ✅ | 凭据加密密钥（32 字节，建议 64 位 hex） |
| `ADMIN_BOOTSTRAP_USERNAME` | ✅ | 管理员初始账号（首次登录时创建） |
| `ADMIN_BOOTSTRAP_PASSWORD` | ✅ | 强管理员初始密码 |

> 其余参数（生成媒体目录、Adobe 上游地址、Token 刷新间隔、媒体保留时长、代理池等）均可在管理后台「系统设置」中配置，无需通过环境变量设置。
>
> sherlockToken 自动铸造变量（`SHERLOCK_MINT_API` / `FP_CHROME_BIN` 等）见 `.env.example`；Docker 必须显式启用 `upstream` profile 才启动 Worker/mint；均不配置则走后台手动输入 token。

---

## 8. 技术栈

- Next.js（App Router）
- TypeScript
- Drizzle ORM + MySQL
- React + Tailwind CSS + Radix UI
- 独立 Worker 进程（持久化任务队列、Token 刷新）
- Vitest（单元测试 + 集成测试）
