# Command Code 可行性核查

核查日期：2026-09-11。范围：官方公开仓库、官方 npm 发布包静态阅读、官方接口文档。未安装或运行发布包，未使用真实账号，未进行模型调用或服务端权限测试。

## 结论

- 账号后台、几百账号的任务调度、并发控制和会话绑定：工程实现把握较大。
- 账号额度查询：已找到明确客户端实现及字段，具备较强实现依据；Cookie 凭证的适用性和真实响应仍需单账号验证。
- 将浏览器 Cookie Token 当成 CLI API Key：没有代码依据，不能视为相同凭证。
- 标准模型转发：在上游权限和协议明确的前提下具备实现路径，Codex 的 Responses 转换需要单独验证。
- 当前每月 1 美元 Go 账号作为统一模型 API 上游：官方不开放 Provider API；客户端静态代码不能证明存在可用的权限绕过，也不能保证私有接口长期稳定。

## 审阅材料与可复现位置

官方 GitHub 主仓库当前默认分支可见内容主要是 README、问题模板及品牌素材，未提供 CLI 核心或服务端核心源码。本次实际读取的是官方发布的客户端 JavaScript 构建产物，并非服务端源码。

- npm 包：command-code，核查时 latest 为 1.53.0。
- 包地址：https://registry.npmjs.org/command-code/-/command-code-1.53.0.tgz
- SHA-512（已与 npm integrity 核对）：XLIjT1Stz+MwsmOK19NCp2Ibqd4RP4cwpxv/ojP1f5xaVWa2rMQvg/UFmYQJ6Q6BXzRJT8sV1+iJAXXX7kDRHw==
- 临时审阅文件：%TEMP%\codex-command-code-1.53.0-review\package\dist\cli.mjs
- CLI 构建文件约 2.57 MB，经过压缩但保留许多可读函数名。
- 下列定位值是该构建文件的零起始 UTF-16 字符偏移，由 PowerShell 字符串索引取得，不是文件字节偏移。更新版本后不能复用。

## 已找到的账号查询逻辑

CLI 以 https://api.commandcode.ai 为生产 API 根地址，正常账号查询包括：

| 用途 | 客户端引用的路径 | 代码依据 |
| --- | --- | --- |
| 身份及组织信息 | /alpha/whoami | fetchUsageWhoami，偏移 51840 |
| 额度细项与窗口 | /alpha/billing/credits | fetchUsageCredits，偏移 51248 |
| 套餐及订阅周期 | /alpha/billing/subscriptions | fetchUsageSubscription，偏移 51602 |
| 用量汇总 | /alpha/usage/summary | fetchUsageSummary，偏移 51983 |

fetchUsageData（偏移 52148）串联以上查询：先取得身份，再依据组织信息查询额度和订阅，随后按账期查询汇总。后台需考虑一次同步涉及多次请求，不能把几百账号同时刷新当作一次请求。

projectUsageView（偏移 53566）读取 monthlyCredits、purchasedCredits、freeCredits、windowLimits、orgLimits 和 currentPeriodEnd 等字段。客户端还对部分总量和百分比进行计算；后台应保留原始细项并区分派生展示，不能把客户端计算结果全部当作上游原始字段。

这些是代码中的预期响应结构；尚未用用户账号验证字段可见性、单位、缺失情况、接口限流及当前服务端行为。

## 凭证与请求头

getCommandAuthKey（偏移 78143）优先使用环境中的 Command Code API Key，随后读取本地认证文件的 apiKey 字段。

buildCommandApiHeaders（偏移 624171）和 buildCommandAuthHeaders（偏移 619911）均包含 Bearer 认证逻辑，并分别处理版本、追踪或会话元数据。被审阅的这两段构建逻辑未使用浏览器 Cookie。

这支持按客户端协议实现正常认证与追踪，不能推导“浏览器 Cookie Token 就是 API Key”，也不能推导“附带客户端标识即可获得其他套餐权限”。

## 模型传输与兼容性

客户端内存在区别于公开 Provider API 的生成通道。调用前使用 toWireMessages（偏移 808045）、toWireTools（偏移 807778）等转换函数，流式响应也有独立错误、停止原因、继续生成和用量处理逻辑。

因此需要验证的不只是 URL 与请求头，还包括：
- 文本、图片、工具调用和工具结果的消息结构。
- 多轮继续、会话标识、缓存以及账号切换后的语义。
- 流式事件、结束原因、取消、错误和实际用量。
- Codex 所需 Responses 接口与上游格式之间的转换。

官方 Provider API 文档明确 Go 套餐缺少 API 权限，并记录 403 upgrade_required。公开客户端代码不包含服务端权限校验实现，本次没有证据证明修改请求头可以解除这一限制。

## 建议的验证顺序

1. 以一个管理员拥有的账号进行只读验证：确认 Cookie 类型以及身份、额度、窗口、套餐信息的实际获取方式。
2. 确认 API 转发采用具有对应权限的上游接入方式，再进行最小文本、流式及工具调用联调。
3. 验证三个目标客户端及会话标识后，加入会话亲和、并发迁移和刷新队列。
4. 最后扩大到几百账号，调整刷新速率及并发上限。

当前完成的是可行性核查和需求文档，尚未声称账号联调或转发成功。

## 来源

- [官方 GitHub 仓库](https://github.com/CommandCodeAI/command-code)
- [官方 npm 版本元数据](https://registry.npmjs.org/command-code/1.53.0)
- [Go 套餐](https://commandcode.ai/docs/plans/go)
- [Provider API](https://commandcode.ai/docs/provider)
- [Command Code BYOK](https://commandcode.ai/docs/byok)
- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
