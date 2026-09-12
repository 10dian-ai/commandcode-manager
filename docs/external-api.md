# 外调服务 API

外部服务可以通过这组端点添加账号、查询账号邮箱及详情、查询导入任务和获取池状态。先登录后台，进入 **API 密钥 → 外调服务 Key → 创建外调服务 Key**，保存创建时显示的完整密钥。

外调服务 Key 使用 `ccm_service_` 前缀，和模型调用的 `ccm_` Key 分开管理、验证。外调 Key 不能调用 `/v1/*`，模型 Key 不能调用 `/api/external/*`。后台登录 Cookie 也不能替代外调 Key。

## 更新已有部署

本次新增 `002_service_keys.sql` 数据库迁移。Docker 部署执行 `docker compose up --build -d` 后，应用和 Worker 启动入口会自动应用迁移；本地开发在启动应用前执行 `npm run db:migrate`。已有账号和模型 Key 保留。

## 认证

每个请求都需要下面两种请求头之一：

```http
Authorization: Bearer ccm_service_你的完整密钥
```

或：

```http
x-api-key: ccm_service_你的完整密钥
```

外部调用使用站点根地址，例如 `https://manager.example.com`；不要在根地址后预先加 `/v1`。以下 curl 示例适用于 Linux/macOS/Ubuntu 终端。将域名、密钥和账号凭证替换为自己的值。

```sh
export CCM_URL='https://manager.example.com'
export CCM_SERVICE_KEY='ccm_service_替换为后台创建的完整密钥'
```

## 添加账号

`POST /api/external/accounts`

请求体必须是 JSON，在 `text`、`token`、`cookie` 中**只提供一个**，可选传入 `groupName`。其他字段不被接受。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `text` | string | 批量导入，每行一个 Token 或完整 Cookie；最多 2,000 行、2,000,000 个字符。 |
| `token` | string | 单个账号的原始会话 Token，最多 8,192 个字符，不允许换行。 |
| `cookie` | string | 单个账号的 Cookie，最多 2,000,000 个字符，不允许换行。 |
| `groupName` | string | 可选分组，首尾空白会被去除，最多 100 个字符。 |

Cookie 支持 `__Secure-commandcode_prod_.session_token=实际Token`，也支持带其他 Cookie 字段的完整 Cookie 请求头；可包含开头的 `Cookie:`。每行必须恰好包含一个正确名称的会话 Cookie。原始 Token 必须为 16–8,192 个可打印 ASCII 字符，不能包含空白、分号、逗号、双引号或反斜杠。凭证不会被 URL 解码或修补。

单个账号：

```sh
curl --fail-with-body "$CCM_URL/api/external/accounts" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"token":"替换为实际会话Token","groupName":"自动导入"}'
```

使用 Cookie：

```sh
curl --fail-with-body "$CCM_URL/api/external/accounts" \
  -H "x-api-key: $CCM_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"cookie":"__Secure-commandcode_prod_.session_token=替换为实际会话Token","groupName":"自动导入"}'
```

批量添加，JSON 中用 `\n` 分隔每行：

```sh
curl --fail-with-body "$CCM_URL/api/external/accounts" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"text":"替换为第一个实际Token\n替换为第二个实际Token","groupName":"批量导入"}'
```

成功排队返回 **HTTP 202**，示例：

```json
{
  "jobId": "f7c51393-d9c4-48f1-b9b7-1d8e37b457cb",
  "accepted": 2,
  "rejected": 0,
  "duplicates": 0
}
```

- `accepted`：通过本地格式校验、去重后，提交给 Worker 处理的凭证数量。
- `rejected`：格式无效的非空行数量。
- `duplicates`：本批重复及数据库中已经存在的相同凭证数量。
- 空行会忽略；行号按原始文本计数。

HTTP 202 只表示任务已排队。身份、订阅、额度和上游 Key 由 Worker 后续验证，最终成功数量需查询任务结果。重复凭证会跳过；同一账号的新凭证在身份确认后可更新已有账号。

## 查询账号列表和邮箱

`GET /api/external/accounts`

返回与后台账号列表相同的分页结构：`{items,total,page,pageSize,groups}`。`items` 中每个账号的 `id` 是本地账号 UUID，`email` 是从上游账号身份同步的邮箱；未提供或尚未同步时为 `null`。

| 查询参数 | 含义 |
| --- | --- |
| `q` | 按账号名称或邮箱搜索，最多 200 个字符。 |
| `status` | 可选 `pending`、`ready`、`credential_expired`、`sync_error`；省略或空字符串表示全部。 |
| `group` | 按分组名称精确筛选，最多 100 个字符。 |
| `page` | 页码，默认 1，范围 1–100,000。 |
| `pageSize` | 每页数量，默认 50，范围 1–200。 |

```sh
curl --fail-with-body --get "$CCM_URL/api/external/accounts" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY" \
  --data-urlencode 'page=1' \
  --data-urlencode 'pageSize=100'
```

筛选邮箱时增加 `--data-urlencode 'q=你的账号邮箱'`。获取整个池子的邮箱时按页读取，直到 `page * pageSize >= total`；默认包含停用账号。

列表还包含账号名称 `label`、分组 `groupName`、备注 `note`、启用状态 `enabled`、同步状态 `status`、最近同步时间 `lastSyncAt`、并发占用 `inFlight` 和最近同步快照 `snapshot`。不会返回登录 Cookie、会话 Token、上游 API Key 或其密文。

## 查询单个账号

`GET /api/external/accounts/:id`

将 `:id` 替换为账号列表中的 `id`。直接返回账号对象，包含 `email` 及列表中的其他账号字段，并增加该账号的模型权限观察列表 `observedModels`。格式无效的 ID 返回 400，账号不存在返回 404。

```sh
curl --fail-with-body "$CCM_URL/api/external/accounts/替换为账号UUID" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY"
```

以上两个查询读取本地已有数据，不触发上游刷新。

## 查询导入进度

`GET /api/external/jobs/:id`

将 `:id` 替换为添加账号时返回的 `jobId`：

```sh
curl --fail-with-body "$CCM_URL/api/external/jobs/f7c51393-d9c4-48f1-b9b7-1d8e37b457cb" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY"
```

完成后的响应示例：

```json
{
  "id": "f7c51393-d9c4-48f1-b9b7-1d8e37b457cb",
  "status": "completed",
  "progress": { "processed": 2, "total": 2 },
  "result": {
    "imported": 1,
    "updated": 1,
    "failed": 0,
    "skipped": 0,
    "errors": []
  },
  "error": null
}
```

常见 `status` 为 `waiting`、`active`、`delayed`、`completed` 和 `failed`。`progress.total` 是实际排队的凭证数，不含格式拒绝和重复条目。非完成状态的 `result` 为 `null`；任务整体失败时 `error` 提供说明。

`completed` 表示队列任务处理结束，仍应检查 `result.failed` 和 `result.errors`：

- `imported` / `updated`：成功新建 / 更新并完成同步的账号数。
- `failed`：包括预先拒绝的格式错误及处理中的失败数量。
- `skipped`：跳过的重复凭证数量。
- `errors`：`{ "line": 2, "message": "失败原因" }` 列表。

可以每隔几秒查询一次，收到 `completed` 或 `failed` 后停止。任务记录会按保留策略清理，ID 不存在或已清理时返回 404。

## 获取池状态

`GET /api/external/pool`

```sh
curl --fail-with-body "$CCM_URL/api/external/pool" \
  -H "Authorization: Bearer $CCM_SERVICE_KEY"
```

响应结构与后台概览相同，以下仅为字段示例：

```json
{
  "counts": {
    "total": 12,
    "enabled": 10,
    "ready": 8,
    "needsAttention": 1,
    "notSynced": 1
  },
  "requests": {
    "total": 240,
    "success": 225,
    "failed": 12,
    "inFlight": 3
  },
  "services": {
    "database": true,
    "redis": true,
    "workerLastSeen": "2026-09-12T08:00:00.000Z",
    "kernel": true
  },
  "lastSyncAt": "2026-09-12T07:59:50.000Z"
}
```

| 字段 | 实际含义 |
| --- | --- |
| `counts.total` | 池中全部账号数量。 |
| `counts.enabled` | 已启用账号数量。 |
| `counts.ready` | 已启用、同步状态为 `ready`、已保存上游 API Key，且最近同步快照未显示配额耗尽的账号数量。 |
| `quota.accountCount` | 参与配额汇总的账号数量，与 `counts.ready` 相同。 |
| `quota.fiveHour` / `quota.weekly` / `quota.monthly` | 分别返回 `used`、`cap`、`remaining`、`knownAccounts`、`unknownAccounts`，表示已用、总额、剩余及该窗口数据已知/未知的账号数。 |
| `counts.needsAttention` | 已启用且状态为 `credential_expired` 或 `sync_error` 的账号数量。 |
| `counts.notSynced` | 尚无成功同步时间的账号数量，包含停用账号。 |
| `requests.total/success/failed` | 当前保留的真实请求日志分别统计的总量、成功量和错误量。 |
| `requests.inFlight` | Redis 中尚未过期的全局请求租约数量。 |
| `services.database/redis` | 本次查询成功读取数据库及 Redis 时为 `true`；读取失败时接口返回错误。 |
| `services.kernel` | 本次内核健康检查是否返回成功。 |
| `services.workerLastSeen` | 最近一次 Worker 心跳时间；没有记录时为 `null`。 |
| `lastSyncAt` | 全部账号中最近的成功同步时间；不表示所有账号都在该时间同步，没有记录时为 `null`。 |

配额按正常且已启用账号的最近快照逐项汇总；未提供的窗口不参与该项总额，并计入 `unknownAccounts`。账号列表和详情增加 `quotaPaused`、`quotaResumeAt`，用于区分系统因配额暂停与手动停用。完整语义见[号池配额与自动恢复](quota-management.md)。

账号统计读取本地最近同步状态，**查询池状态不会触发上游额度刷新**。`ready` 不代表当前额度足够、特定模型已授权或当前还有并发空位。各计数按自身条件独立统计，存在重叠，不能用总数相减推导其他分类。请求日志统计也不代表上游账单或剩余额度。

## 错误与密钥管理

- **400**：JSON 结构、字段、分页筛选参数、账号或任务 ID 格式无效；批量文本超限也会被拒绝。逐行凭证格式错误通常记录到 `rejected`，随后可在任务结果中查看。
- **401**：外调 Key 缺失、无效、停用或已撤销，或使用了模型 Key。
- **404**：账号不存在，或导入任务不存在、已过期。
- **5xx**：服务或依赖暂时不可用，应保留错误信息并重试。

外调 Key 的创建、停用、启用、撤销都在后台 **API 密钥 → 外调服务 Key** 操作。每个启用的外调 Key 都具有这组五个端点的访问权限；这组端点不提供 Key 管理接口，不能代替管理员登录后台。
