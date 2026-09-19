# Mob AI Router 接入

Cynosure 0.2 复用 Router 的三个接口：

- `POST https://ai.mob-ai.cn/api/v1/chat/completions`：候选模型和可选评审模型。
- `POST https://ai.mob-ai.cn/api/v1/embeddings`：经验 embedding。
- `POST https://ai.mob-ai.cn/api/v1/decisions`：Jev 原生决策。

只需 `MOB_AI_API_KEY`。Jev 使用 Router 的 `/api/v1/decisions`，由 Router 使用 OpenRouter 渠道转发原生 state/questions/answers，并在同一虚拟 key 下计费。Cynosure 不保存 OpenRouter key。默认 embedding 为已实测的 `jina-embeddings-v5-text-small`（1024 维）。

Jev 的 `usage.cost` 为 Router 报告的美元费用；生成也支持 Router 的 `usage.cost_usd` / `usage.cost.total_cost_usd`。若费用标为 estimated，保留估算属性；缺失价格的 embedding 保持 unknown 并保留预算，不按免费计算。

真实验证前通过带认证的 `GET /v1/models` 确认模型目录，尤其是 embedding 模型 ID。配置中的价格、上下文、版本和每次预留必须匹配实际服务，示例本身不证明目录存在或调用成功。

Cynosure 当前发送文本 Chat Completions（SSE 流式接收，完整后交付）、标准 embedding 和原生 Decisions 请求。生成输出必须非空、finish_reason=stop 且收到 [DONE]；截断、工具调用、错误和缺失完成状态不算成功。没有用 200 状态码替代完成证据。

现有 Router 负责凭据、提供商调度和账户账单。Cynosure 负责本任务的预留记录和决策反馈；不替代全账户额度。当前本地 SQLite 路径尚未集成到生产 Worker，也没有修改线上 `cynosure/auto`。

调用方可以用 `Store.feedback(taskId, feedback)` 回传带来源的验收、真实工具次数和 task/request 观测范围。该方法是可信本地接口；若以后公开 HTTP 接口，必须由宿主绑定认证 scope，不能相信客户端自报租户。
