# 运行说明

Cynosure 0.2 的公开入口为 `Cynosure`、`Store`、`parseConfig`、`parseTask` 和类型定义。本地 Store 需要 Node.js 24+、内置 `node:sqlite` 与固定版本的 sqlite-vec 原生扩展。CoreStore 抽取同步数据库接口；线上使用 Cloudflare SQLite 适配器和精确 cosine 检索，无需加载原生扩展。

当前提供文本 CLI、Pi 宿主扩展，以及已部署到 Router 的 `cynosure/auto` 线上入口。线上按 key 隔离并持久化请求、经验和反馈；部署、迁移与真实请求验证见 [Router 接入](integrations/mob-ai-router.md)。

经验库使用 SQLite `user_version=1`。未知版本拒绝打开，不自动迁移。中断任务保留 `running` 和未结算预留，相同任务 ID 拒绝再次提交；宿主需要先核对实际调用，再决定是否用新 ID 重试。

`scope` 由可信调用方绑定，用于本地经验隔离，不是身份认证。真实输入、输出、工具结果会落盘，需要保护数据目录。费用预留是调用准入合同，供应商账单、长任务总预算和宿主工具权限分别由对应系统负责。

完整设计见[当前架构](architecture.md)；参数见[配置](configuration.md)，实际反馈见 [Pi 接入](integrations/pi.md)。
