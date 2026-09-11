# 首版开发与验证记录

日期：2026-09-12。

## 已通过

- npm run check 退出码0：Nuxt与Worker类型检查、Vitest、Nuxt生产构建、Worker/迁移打包及固定内核构建。
- Vitest：55通过，9个需要真实PostgreSQL/Redis的用例跳过。
- 18个Vue文件独立模板/脚本/CSS编译，40个Phosphor图标存在，前端文件无BOM。
- Compose与开发覆盖配置静态校验通过。
- 本机生产冒烟：health200、匿名session200、login页面200、无效登录输入400、网关无Key401、CORS OPTIONS204。
- 登录页桌面截图目视检查通过：artifacts/ui-login-desktop.png。
- 真实上游Cookie没有写入源文件；.env只包含本机生成的开发配置且被忽略。

## 未执行

PostgreSQL集成3项、Redis集成6项；Compose镜像构建与整套服务启动；新管理系统中的真实批量导入及三客户端端到端联调。

本机Docker因早于本任务的dockerInference AF_UNIX socket报Win32 1920，无法启动引擎。没有重置Docker、删除其数据或修改系统功能。TEST_DATABASE_URL/TEST_REDIS_URL及CI真实服务配置已准备，本轮未远程运行CI。

## 安装与打包

中断安装产生的不完整依赖和锁文件已保留至artifacts/install-recovery-*；完成干净重装后检查与构建成功。恢复目录不属于发布内容。

生产镜像的运行依赖安装使用--ignore-scripts，避免执行需要开发依赖的Nuxt prepare；构建阶段执行完整安装和构建。

本机冒烟只验证无需数据库的匿名和拒绝路径，不代表登录后的真实数据工作流已经通过。
