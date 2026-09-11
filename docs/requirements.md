# Command Code Manager 首版需求与实现

更新：2026-09-12。首版代码与生产构建已完成；真实 PostgreSQL、Redis 和整套 Compose 联调尚未完成。

## 已确认需求

- 单管理员自用，管理几百个每月 1 美元的 Go 账号。
- 批量粘贴 Cookie，读取真实身份、套餐、额度、窗口和用量。
- 自动创建并加密保存专用上游 Key，客户端使用本系统签发的独立 Key。
- 接入 Command Code、Codex、Claude Code 及自制客户端。
- 新会话按并发分配；原账号满载时允许迁移后续请求，在途请求保持原账号。
- 活跃账号优先刷新，闲置账号定时刷新，展示获取时间及错误状态。
- 完整业务日志默认保存 30 天，可调整。
- Ubuntu + 1Panel，24 核 / 128 GB；使用 Docker Compose、PostgreSQL、Redis。
- 内核由我们适配、测试和发布，项目没有自动升级内核功能。

## 已实现

中文后台、账号分页及批量操作、导入任务进度、账号详情和模型观察记录、访问密钥、日志详情、设置；SQL迁移、密文凭证和密文队列、专用Key创建意图及有限恢复；Worker同步、互斥、查询限速、优先级、退避和清理；网关三协议入口、Redis原子租约、亲和与迁移、取消/背压、错误分类和内容日志；固定版本内核构建及Compose部署。

技术栈：Nuxt 4 / Vue 3 / TypeScript / Nuxt UI / Node.js 24 / PostgreSQL 17 / postgres.js / Redis 7.4 / BullMQ 5。使用 npm 锁文件与 SQL 迁移。

## 数据语义

- 账号额度使用上游原始返回；本地日志统计独立展示，分类计数独立查询真实记录。
- 目录不等于账号权限，模型状态区分观察到的允许、拒绝和未验证。
- MODEL_NOT_IN_PLAN 只影响对应模型；HTTP401本身不代表永久封禁。
- limited=true不等于额度耗尽，resetAt=0不生成虚构重置时间。
- 额度与用量汇总不一致时保留各自真实结果。
- 流式输出后不重放；不盲目重试未知是否执行的失败。
- 认证字段不进入业务日志，超出响应捕获上限时明确标记截断。

## 默认配置

全局并发20、单账号2；刷新并发2、每秒官方查询请求数2；活跃60秒、闲置300秒；亲和24小时；日志30天；请求体默认16MB、可调至64MB。刷新周期是调度目标，以实际更新时间为准。

## 已有真实核验

- 一个Go账号的Cookie身份、额度、订阅、用量查询已通过。
- 官方Provider API对69个模型全部拒绝Go的API访问。
- 原始第三方内核对同一账号测试69模型：38个文本返回、25个套餐拒绝、3个上游错误、2个仅推理并达到输出上限、1个无有效内容且达到上限。
- 内核路径已有真实调用依据，官方Provider API拒绝不能替代内核测试结果；不保证所有模型和完整客户端能力。
- 记录见 docs/account-readonly-verification.md、docs/kernel-review.md 与本地 artifacts/kernel-model-probes/。

## 验证边界

当前内核锁定621730578ff95b56a1df77e3dda3396cdfd2c585，CLI1.53.0。
类型、55项离线测试和生产构建已通过；9项真实服务集成测试受本机Docker故障阻塞，见[开发记录](development-status.md)。

Responses暂不支持previous_response_id、store:true、服务端内建工具及完整加密reasoning状态。三客户端完整工作流、流式工具多轮和真实账号池需部署联调。

部署时再确认Ubuntu版本、域名和OpenResty网络。启动与备份步骤见[README](../README.md)。
