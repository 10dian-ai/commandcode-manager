# Cookie 只读接口验证

验证日期：2026-09-11。范围：用户明确授权的单个 Command Code 账号，仅查询官方接口。未调用模型、未创建或更改 API Key。

## 已验证链路

使用用户提供的准确 Cookie 文本，以下接口均返回 HTTP 200：

| 接口 | 结果 |
| --- | --- |
| GET /auth/get-session | 返回 session 和 user，认证成功 |
| GET /internal/billing/credits | 返回 credits 和 windowLimits |
| GET /internal/billing/subscriptions | success，返回有效订阅 |
| GET /internal/usage/summary | 返回用量汇总字段 |

API 域名为 api.commandcode.ai，网页 Origin 为 https://commandcode.ai。

Cookie 名称为 __Secure-commandcode_prod_.session_token。Cookie 值未写入该文档或项目文件。

## 真实响应确认

- planId：individual-go。
- 订阅 status：active。
- credits.monthlyCredits：10。
- credits.purchasedCredits：0。
- 五小时窗口：used=0，cap=3，exceeded=false。
- 周窗口：used=0，cap=6，exceeded=false。
- windowLimits.limited=true，exceeded=null；不能仅凭 limited=true 把账号判为已用尽。
- 两个窗口 resetAt 均为 0；界面应显示暂未提供重置时间，不能显示 1970 年时间或自行推定具体重置时刻。
- 账期开始：2026-09-05T07:35:12Z；账期结束：2026-10-05T07:35:12Z。
- cancelAtPeriodEnd：false。
- 此次用量汇总 totalCost=0、totalTokens=0。

credits 对象还包含 belowThreshold、creditThreshold、premiumMonthlyCredits、opensourceMonthlyCredits、monthlyCreditsGranted。尚未为这些字段确认全部业务语义，应继续结合页面实际使用方式处理。

用量汇总包含 totalCount、completedCount、failedCount、totalTokensIn、totalTokensOut、totalTokens、totalCredits、totalFreeCredits、totalMonthlyCredits、totalPurchasedCredits、periodBasis 等字段。统计周期应按实际查询参数及 periodBasis 展示。

## 实施影响

- Cookie 导入后直接读取账号身份、套餐、额度及用量，已由单个真实账号验证。
- 先前图片转写尝试返回未登录；准确文本已验证有效，不能将先前识别失败记为账号故障。
- 这不证明 Cookie 可作为模型调用 API Key，也不证明 Go 拥有 Provider API 权限。
- 本次没有进行真实模型调用，内核和三种客户端的转发能力仍待验证。
- 后续开发使用 Cookie 原值；不对任意凭证实施 OCR 字符修正、猜测或不必要的 URL 转码。
- 本文只记录结果和字段，不包含账号身份标识、邮箱、Cookie 值、API Key 或完整认证响应。
