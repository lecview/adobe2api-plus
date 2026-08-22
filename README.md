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

Adobe Firefly 的第三方模型端点（`firefly-3p.ff.adobe.io`，承载 GPT / Flux / Gemini 等）在账号被风控标记时会返回 `408`（「system under load」）。实测证明这个 `408` **并非真正的高负载，而是账号级别的风控标记**：

1. **根因**：408 与请求体、指纹质量、token 结构、cookie、代理 IP 均无关——唯一决定性变量是账号是否被上游标记。批量注册的池账号（低安全评级 `MedSecNoEV,LowSec`）普遍被标记；正常注册、有使用史的干净账号畅通无阻。

2. **处理策略**：
   - **408 → 标记风控，换号重试**：提交遇到 408 时，把该账号标记为「已风控」（从随机选号池中移除，**不删除**），换一个账号重试（最多 3 次）；标记可在后台手动解除。
   - **401 → 彻底删除**：401 表示 token 已失效，直接删除账号（任务历史靠快照保留），与 408 明确区分。

3. **sherlockToken（`x-arp-session-id`）**：维护浏览器会话态，通过 [Roxy 浏览器](https://roxybrowser.cn/invite/XZx8Sf)自动铸造或手动输入，由 worker 按固定周期（默认 5 分钟）自动刷新，提交链路自动使用最新 token。

> 因此：**账号供给是唯一瓶颈** —— 第三方模型端点能否使用取决于账号是否被标记，需要干净账号。

> 🎁 sherlockToken 依赖 [Roxy 浏览器](https://roxybrowser.cn/invite/XZx8Sf)自动铸造，欢迎使用我们的推广链接注册。

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

前置：已安装 [Docker](https://www.docker.com/) 与 Docker Compose。

1. **克隆项目**：

```bash
git clone https://github.com/songsongQAQ/adobe2api-plus.git
cd adobe2api-plus
```

2. **配置环境变量**（只需填两个安全密钥）：

```bash
cp .env.example .env
openssl rand -hex 32   # 输出填入 .env 的 SESSION_SECRET
openssl rand -hex 16   # 输出填入 .env 的 ENCRYPTION_KEY
```

`.env` 里还可选设置 `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`（首次启动自动创建的管理员账号）。

3. **一键构建并启动**（自动拉取 MySQL 8 镜像、创建数据库与表结构、启动 Web + Worker）：

```bash
docker compose up -d --build
```

4. **访问管理后台**：

- 地址：`http://127.0.0.1:3000/login`
- 账号：`admin`（或你在 `.env` 中设置的用户名）
- 密码：`.env` 中的 `ADMIN_BOOTSTRAP_PASSWORD`；未设置则回退为默认 `admin123`（**生产环境务必修改**）

> - 数据库（MySQL 8）随 compose 自动启动，表结构由应用首次启动时自动迁移，**无需手动 `db:push`**。
> - 数据持久化：MySQL 数据在 `mysql-data` 卷，生成媒体在 `generated-media` 卷。
> - 查看状态/日志：`docker compose ps`、`docker compose logs -f web worker`。
> - 数据库账号默认 `adobe / adobe`（库名 `adobe`），可通过 `.env` 的 `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` 覆盖。

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

模型 ID 采用 `{family}-{分辨率}-{比例}` 或 `{family}-{时长}s-{比例}-{分辨率}` 的命名。为兼容旧 `adobe2api` 调用方，也接受带 `firefly-` 前缀的模型 ID（自动归一化）。

#### 图像模型

Nano Banana / Nano Banana Pro（上游 `nano-banana-2`）：

- 命名：`nano-banana-{res}-{ratio}` / `nano-banana-pro-{res}-{ratio}`
- 分辨率：`1k` / `2k` / `4k`
- 比例后缀：`1x1` / `16x9` / `9x16` / `4x3` / `3x4` / `5x4` / `4x5` / `3x2` / `2x3` / `21x9`
- 示例：`nano-banana-pro-2k-16x9`、`nano-banana-4k-1x1`

Nano Banana 2（上游 `nano-banana-3`）：

- 命名：`nano-banana2-{res}-{ratio}`
- 分辨率：`1k` / `2k` / `4k`
- 额外支持超长比例：`1x8` / `1x4` / `4x1` / `8x1`
- 示例：`nano-banana2-2k-16x9`、`nano-banana2-2k-1x8`

GPT Image（上游 `gpt-image`，版本 `2`）：

- 命名：`gpt-image-{res}-{ratio}`
- 分辨率：`1k` / `2k` / `4k`
- 示例：`gpt-image-2k-16x9`、`gpt-image-4k-1x1`

> `aspect_ratio=auto` **不支持**，请求传入 `auto` 会回退为 `1:1`，请显式传具体比例或使用带比例后缀的模型 ID。默认模型为 `nano-banana-pro-2k-16x9`。

#### 视频模型

Sora2 / Sora2 Pro：

- 命名：`sora2-{dur}s-{ratio}` / `sora2-pro-{dur}s-{ratio}`
- 时长：`4s` / `8s` / `12s`；比例：`9x16` / `16x9`
- 示例：`sora2-4s-16x9`、`sora2-pro-8s-9x16`

Veo31（帧模式）：

- 命名：`veo31-{dur}s-{ratio}-{res}`
- 时长：`4s` / `6s` / `8s`；比例：`16x9` / `9x16`；分辨率：`720p` / `1080p`
- 1 张参考图 = 首帧；2 张 = 首帧 + 尾帧
- 示例：`veo31-4s-16x9-1080p`

Veo31 Ref（参考图模式）：

- 命名：`veo31-ref-{dur}s-{ratio}-{res}`
- 最多 3 张参考图
- 示例：`veo31-ref-6s-9x16-720p`

Gemini Omni：

- 命名：`gemini-omni-{dur}s-{ratio}-{res}`
- 时长：`4s` / `6s` / `8s` / `10s`；分辨率：`720p` / `1080p`
- 最多 4 张图片参考（风格）+ 1 个视频参考（来源）
- 不带分辨率的兼容模型 ID 默认 `720p`
- 示例：`gemini-omni-10s-16x9-1080p`

Kling 3.0：

- 命名：`kling3-{dur}s-{ratio}-{res}`
- 时长：`5s` / `10s` / `15s`；比例：`16x9` / `9x16`
- 1 张为首帧，2 张为首帧 + 尾帧；音频默认开启
- 不带分辨率的兼容模型 ID 默认 `720p`
- 示例：`kling3-5s-16x9-720p`、`kling3-15s-9x16`

Kling O3：

- 命名：`kling-o3-{dur}s-{ratio}-{res}`
- 时长：`5s` / `15s`；分辨率：`720p` / `1080p`
- 支持通过 `@entity:实体名` 引用已创建实体
- 不带分辨率的兼容模型 ID 默认 `1080p`
- 示例：`kling-o3-5s-16x9`

Seedance 2.0 / 2.0 Fast：

- 命名：`seedance20-{dur}s-{ratio}-{res}` / `seedance20-fast-{dur}s-{ratio}-{res}`
- 时长：`4s` ~ `15s`；比例：`21x9` / `16x9` / `4x3` / `1x1` / `3x4` / `9x16`；分辨率：`480p` / `720p` / `1080p`
- 最多 9 张图片（风格）+ 3 个视频（来源）+ 3 个音频（来源），三类合计最多 12 项
- 音频参考必须搭配至少 1 张图片或 1 个视频；音频默认开启
- 示例：`seedance20-4s-16x9-480p`、`seedance20-fast-15s-9x16-1080p`

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
    "model": "nano-banana-pro-2k-16x9",
    "messages": [{"role":"user","content":"a cinematic mountain sunrise"}]
  }'
```

图生图（在最新 user 消息中传入图片）：

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

文生视频：

```bash
curl -X POST "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sora2-4s-16x9",
    "messages": [{"role":"user","content":"a drone shot over snowy forest"}]
  }'
```

图生视频：

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

Gemini Omni 视频参考（在最新 user 消息中传入视频）：

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

支持在请求中设置 `"stream": true` 以 SSE 流式接收生成进度。

### 3.3 图像接口：`/v1/images/generations`

```bash
curl -X POST "http://127.0.0.1:3000/v1/images/generations" \
  -H "Authorization: Bearer <service_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro-4k-16x9",
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
    "model": "nano-banana-pro-2k-1x1",
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
    "model": "kling3-5s-16x9-720p",
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
    "model": "kling-o3-5s-16x9",
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
| `DATABASE_URL` | ✅ | MySQL 连接串（必须 `mysql:` 协议，含库名） |
| `SESSION_SECRET` | ✅ | 会话加密密钥（≥32 字节，`openssl rand -hex 32` 生成） |
| `ENCRYPTION_KEY` | ✅ | 凭据加密密钥（≥16 字节） |
| `ADMIN_BOOTSTRAP_USERNAME` | — | 管理员初始账号 |
| `ADMIN_BOOTSTRAP_PASSWORD` | — | 管理员初始密码 |
| `MEDIA_ROOT` | — | 生成媒体目录，默认 `./data/generated` |
| `MEDIA_PUBLIC_PREFIX` | — | 媒体对外前缀，默认 `/generated` |
| `ADOBE_BASE_URL` | — | Adobe 上游基址 |
| `ADOBE_API_KEY` | — | Adobe 上游 client id（默认 `clio-playground-web`） |
| `ADOBE_TIMEOUT_MS` | — | 上游请求超时，默认 60000 |
| `ADOBE_GENERATE_TIMEOUT_MS` | — | 生成超时，默认 300000 |
| `REFRESH_INTERVAL_HOURS` | — | Token 自动刷新间隔，默认 15 |
| `MEDIA_RETENTION_DAYS` | — | 媒体保留天数，默认 30 |
| `WORKER_ID` | — | Worker 标识，默认 `worker-default` |
| `ROXYBROWSER_API_BASE` | — | Roxy 浏览器 API 地址（自动铸造 sherlockToken 时必填） |
| `ROXYBROWSER_API_TOKEN` | — | Roxy 浏览器 API Key（同上；工作区/窗口 ID 由程序自动获取） |
| `ROXYBROWSER_CDP_HOST` | — | 容器内访问宿主机 RoxyBrowser 的 CDP 地址（如 `host.docker.internal`） |
| `ROXYBROWSER_MINT_API` | — | 宿主机 sherlock 铸造服务地址（配置后优先走该服务，无需直连 CDP） |

---

## 8. 技术栈

- Next.js（App Router）
- TypeScript
- Drizzle ORM + MySQL
- React + Tailwind CSS + Radix UI
- 独立 Worker 进程（持久化任务队列、Token 刷新）
- Vitest（单元测试 + 集成测试）
