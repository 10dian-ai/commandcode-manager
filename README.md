# Command Code Manager

单管理员的 Command Code 账号管理后台与统一调用网关。支持批量 Cookie 导入、真实额度查询、会话亲和、并发分配、调用日志及固定版本内核。

## 技术栈

- Nuxt 4、Vue 3、TypeScript、Nuxt UI；中文响应式后台。
- Node.js 24；PostgreSQL 17（SQL 迁移）；Redis 7.4 + BullMQ。
- 独立 commandcode-proxy 内核，固定上游提交 6217305，由本项目构建适配版本。
- Docker Compose 管理 app、worker、kernel、postgres、redis。
- 项目没有自动下载或升级内核的功能。

## 首次运行

在项目目录执行：

```sh
npm ci
npm run setup
docker compose up --build -d
```

setup 自动创建随机数据库密码、Redis 密码、管理员密码及 32 字节凭证加密密钥。已有 .env 时不会覆盖。管理员用户名默认为 admin，密码位于本地 .env 的 ADMIN_PASSWORD。不要提交 .env。

默认后台只发布到主机 127.0.0.1:3000。浏览器访问本机 http://localhost:3000。数据库、Redis 和内核不发布到公网。

只有 Docker 的 Ubuntu 服务器可以这样生成配置，无需在主机安装 Node：

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work node:24-alpine node scripts/setup.mjs
docker compose up --build -d
```

正式域名部署前，将 .env 的 APP_URL 改为实际 HTTPS 地址。

## 1Panel 反向代理

如果 OpenResty 在主机网络中，可反向代理至 http://127.0.0.1:3000。

如果 OpenResty 在独立容器网络中：

1. 在 1Panel 或 docker network ls 中确认 OpenResty 实际加入的网络。
2. 在 .env 添加 PANEL_NETWORK=实际网络名。
3. 使用持久化的 Compose 网络声明启动：

```sh
docker compose -f compose.yml -f ops/compose.1panel.yml up --build -d
```

4. 在 1Panel 新建反向代理网站，上游填写 http://ccm-app:3000 并配置 HTTPS。

不要使用固定容器 IP。Nginx/OpenResty 的网关路由需要关闭响应缓冲并允许长连接，例如 proxy_buffering off 与足够长的 proxy_read_timeout，以便 SSE 流式输出。

## 本地开发

```sh
npm ci
npm run setup
docker compose -f compose.yml -f compose.dev.yml up --build -d postgres redis kernel
npm run db:migrate
npm run dev
```

另一个终端执行 npm run dev:worker。compose.dev.yml 只把开发端口绑定在 localhost，.env 自动生成的连接地址与这些端口一致。

## 使用流程

1. 登录后台，打开账号页面，按一行一个 Cookie Token 批量粘贴。
2. Worker 验证身份，查询额度和订阅，并在需要时创建专用上游 Key。Cookie 和上游 Key 使用 AES-256-GCM 加密；导入队列中也不存明文 Cookie。
3. 观察最后同步时间和错误状态。模型目录不等于账号权限，模型页面区分真实观察到的允许、拒绝和未验证状态。
4. 创建本系统访问 Key（ccm_ 前缀，只显示一次），填入客户端。不要把上游账号 Cookie 填入客户端。
5. 客户端 base URL 为你的域名加 /v1。网关支持 /v1/chat/completions、/v1/messages、/v1/responses 和 /v1/models。
6. 根据需要调整全局并发、默认账号并发、刷新周期、日志保留期限和亲和时长。

## 外调服务 API

在后台 **API 密钥 → 外调服务 Key** 创建独立的 `ccm_service_` 密钥，即可通过 API 添加账号、查询导入任务和读取池状态。外调 Key 与客户端使用的模型 API Key 分开验证。

- `POST /api/external/accounts`：提交单个或批量账号，返回导入任务 ID。
- `GET /api/external/jobs/:id`：查询导入进度和最终结果。
- `GET /api/external/pool`：读取与后台概览相同的账号、请求及服务状态。

请求使用 `Authorization: Bearer <外调服务 Key>` 或 `x-api-key: <外调服务 Key>`。完整 curl 示例、响应字段及统计语义见 [外调服务 API 文档](docs/external-api.md)。

## 调度与数据语义

- 新会话按实际占用分配账号，同一会话优先复用原账号，满载时可为后续请求迁移；正在执行的请求不会中途换号。
- Redis 原子校验全局与账号并发；租约续期、过期恢复及幂等释放处理取消和进程异常。
- MODEL_NOT_IN_PLAN 只影响对应账号的模型观察记录，HTTP 401 本身不会导致永久弃号。
- 本地调用日志统计与上游账单数据分别保存，不用本地消耗递减官方余额冒充实时额度。
- limited=true 表示窗口限制存在，并不等于已超限；resetAt=0 显示未提供。
- Cookie 失效或查询失败保留最后成功快照，同时展示状态及时间。
- 导入自动创建 Key 使用持久意图记录处理不确定结果；只核对和清理本系统确认创建的孤儿 Key。
- 完整业务请求与回复保留默认 30 天，可调整；认证字段不写日志，超过响应捕获上限会明确标记截断。

## 内核维护

原始源码保留在 reference/commandcode-proxy-6217305，MIT 许可证随构建产物保留。

```sh
node scripts/build-core.mjs
```

构建脚本先校验源文件摘要，再生成 core/dist 及版本清单，修复已确认的 Responses 兼容问题并锁定 CLI 版本。升级由维护者引入新快照、审阅差异、更新补丁和测试后发布新镜像。生产环境不会自行追踪 latest 或升级内核。

当前 Responses 不支持 previous_response_id、store:true、服务端内建工具和完整加密 reasoning 状态。不能把基础文本调用通过当作这些能力已经可用。

## 验证

```sh
npm run check
```

真实数据库与 Redis 集成测试在提供 TEST_DATABASE_URL、TEST_REDIS_URL 时启用。数据库测试只操作随机 schema，Redis 测试只操作随机前缀，不清空已有数据。

GitHub Actions 的检查流程包含 PostgreSQL 和 Redis 服务。本机没有 Docker 引擎时，相关集成用例会明确跳过。具体本轮验证状态见 docs/development-status.md。

## 备份和恢复

需要一起备份 PostgreSQL 数据、Redis 数据和 .env。特别保留 APP_ENCRYPTION_KEY；更换或丢失它会使已有账号凭证无法解密。

升级应用前备份数据库与配置。内核镜像可单独切回上一版，涉及数据库迁移的版本需另行检查迁移兼容性。不要使用 docker compose down -v 作为日常重启命令。

普通重启：

```sh
docker compose restart
```

## 现有核查材料

- docs/requirements.md：需求与实时核查记录。
- docs/kernel-review.md：内核源码评审。
- docs/account-readonly-verification.md：真实 Cookie 查询验证。
- artifacts/kernel-model-probes/：此前单账号 69 模型实测记录（本地生成，默认不纳入版本库）。

## 上游许可证

适配内核源自 MAXeaglet/commandcode-proxy，使用 MIT 许可证；版权声明位于上游快照及 core/dist/LICENSE。
