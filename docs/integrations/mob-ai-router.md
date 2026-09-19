# Mob AI Router 接入

## 直接使用线上模型

2026-09-19 起，Cynosure 0.2 已部署到 Mob AI Router。使用现有 Router key，Base URL 为 `https://ai.mob-ai.cn/api/v1`，模型 ID 为 `cynosure/auto`。支持文本 coding 场景的 Chat Completions、Responses 和 function tools；无需运行本地 Cynosure 服务或预先准备经验。

线上复用现有 Cloudflare 网关，每个认证 key 对应独立的 SQLite Durable Object。原始 key 不落库；生成、Jina embedding 和 Jev Decisions 通过同一个 key 计费。Jev 仍由 Router 使用 OpenRouter 渠道转发。终端候选是 Grok 4.6、DeepSeek V4 Flash、GLM 5.3、GLM 5.3 Flash。

生成接收完整客户端历史，输出上限为 262144 token，GLM 两款按实际能力为 131072。路由判断使用有明确截取标记的当前用户请求与近期上下文。SSE 会先发送心跳，完整候选经过协议检查后再输出所选结果，目前不是逐 token 透传。工具由客户端执行。

建议每个会话传稳定的 `x-cynosure-session-id`；默认由第一条用户消息生成。后续请求中的工具结果，只关联同一 key、同一会话中实际交付的 tool call ID。Responses 的 `previous_response_id` 会从所属 key 的存储中恢复完整历史，支持后续交互。

## 请求记录与反馈

所有接口使用现有 bearer key：

- `GET /cynosure/status`：部署版本与当前 key 的持久化数量。
- `GET /cynosure/records`：请求列表。
- `GET /cynosure/records/<id>`：请求、结果、调用、Jev 决策与反馈；`?events=1` 返回完整事件。
- `POST /cynosure/records/<id>/feedback`：提交真实验收或失败原因。
- `GET /cynosure/archives`：该 key 私有历史档案列表。

请求 ID 位于响应头 `x-cynosure-record-id`。反馈示例：

```json
{"scope":"task","verdict":"unmet","note":"空输入回归测试仍失败","toolCalls":3}
```

`scope` 为 `request` 或 `task`；`verdict` 为 `met`、`partial`、`unmet` 或 `unknown`。反馈会随相关历史经验进入后续 Jev 决策。工具结果与交付成功本身不自动变成任务通过；没有验收证据时保留 unknown。普通下一轮用户纠正也进入当前决策上下文。

生成和反馈均支持 `Idempotency-Key`。完成请求重放存储结果，执行中重复请求返回 409，失败请求返回原失败；不会因重复提交再次计费。

## 部署与迁移验收

当前 Router 代码提交为 [002f318](https://github.com/MobAI-Inc/mob-ai-router/commit/002f318)，生产策略版本 `cynosure-online-0.2-20260919`。核心源文件与本项目对应实现一致，Cloudflare 使用轻量存储适配器；向量检索采用精确 cosine，结合 FTS5/RRF。经验、调用与反馈按 key 隔离。

有效 Pi 在线经验已迁移 107 条任务、364 次调用、1172 条事件、8 组缓存向量。生产逐条读回，任务正文、全部事件、调用数量及导入校验和全部匹配。1250 个历史数据库与轨迹文件另存私有档案，评测集、冻结 seed、基线和排除样本不注入有效在线经验。密钥配置、项目源代码副本与依赖未打包。迁移入口已关闭。

网关 711 项测试通过，另完成 5 个生产真实请求：工具提案、工具结果回传、反馈后的后续决策、Responses 首次调用和续接。显式反馈确实进入了后续 Jev 的 experience，检索同时命中迁移历史。这证明部署、交付与反馈链路可用；大规模生产收益和长期收敛仍待验证。

## 本地库和 Pi 扩展

本地运行仍只需 `MOB_AI_API_KEY`，复用 Router 的 `/chat/completions`、`/embeddings` 和 `/decisions`。默认 embedding 为 `jina-embeddings-v5-text-small`（1024 维）。本地 `Store.feedback(taskId, feedback)` 是可信宿主接口；服务端认证隔离由上述线上适配器负责。

Jev 的 `usage.cost` 是 Router 报告费用；生成也支持 `usage.cost_usd` / `usage.cost.total_cost_usd`。估算保留 estimated，缺失费用保留 unknown，不当成免费。Router 负责账户账单和凭据，Cynosure 负责单请求调用预留与决策反馈；二者分别记录。线上单次预算默认 $10，未改变已配置账户的 $1000 总额度。

本地 CLI 的纯文本生成要求非空内容、finish_reason=stop 和 [DONE]；Pi 与线上适配器支持工具输出并检查对应完成状态。HTTP 200 不是生成完成证据。
