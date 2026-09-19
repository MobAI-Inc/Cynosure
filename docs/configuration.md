# 配置

`config/router.example.json` 是无密钥示例；配置使用 JSON，环境变量只提供认证。

| 字段 | 含义 |
| --- | --- |
| router.baseUrl / apiKeyEnv | Chat Completions、Embeddings、Decisions 的统一 `/v1` 基址、密钥环境变量名 |
| jev | 决策模型和版本；使用 router.baseUrl 下的 /decisions，与生成、embedding 共用 router.apiKeyEnv |
| embedding | Router 上可调用的 embedding 模型和版本 |
| routes | 1–16 个文本执行候选，模型名唯一；不填质量分 |
| judge（可选） | 独立生成型评审模型；评价用于选择与反馈，不拦截交付 |
| fallbackModel | 必须是 routes 中的模型 ID；默认示例为 Grok 4.6，无法决策时完成交付 |
| limits | 每次 HTTP 超时、总 Jev 次数、并发、响应体上限、经验上下文大小 |
| memory | 检索 topK 和经验最大年龄；scope 必须相同 |
| auditRate | 文本 CLI 的固定抽查比例，示例为 0；Pi 关闭随机抽查，由 Jev 根据当前证据决定是否探索 |

每个模型配置 `id`、`revision`、`maxInputBytes`、`reserveMicroUsd`。revision 标识当前部署/供应商版本或明确的目录快照；模型别名发生变化要更新，embedding 版本变化后绝不混用向量。maxInputBytes 限制完整请求 JSON 字节数，不冒充精确 token 计数。上下文兼容性需用模型限制配置保守的字节上限。

生成默认发送 256k（262,144 tokens），不设置任务级 token 调参项。模型目录能力用可选 `outputTokenLimit` 声明，实际发送 `min(262144, outputTokenLimit)`：GLM 5.3 和 GLM 5.3 Flash 的输出上限为 131,072，其他当前候选使用 262,144。`maxInputBytes` 是请求体字节限制，不代表模型的 input token 上限，也不能据此否认 GLM 的百万 token 上下文能力。

SSE 流式接收，收到 finish_reason=stop 和 [DONE] 后才有完整答案；当前请求超时为 3,600 秒，响应体允许 100 MB。Jev 原生 Decisions 不发送 max_tokens，embedding 不生成文本。

`reserveMicroUsd` 是每次调用的预算预留，1,000,000 micro-USD = 1 USD。它不是供应商强制报价。所有付费调用先原子预留；实际回报 `usage.cost` 时按美元换算。没有成本时可由显式 `pricing` 估算，仍保留整个预留。缺少 usage 不解释为免费。

示例价格来自实际 Router 目录，属于供应商元数据，不是模型能力分数或历史经验。当前价格表只表达普通输入区间，不能用于精确计算 Grok 超过 200K 输入 token 的高上下文档位；这类请求及缓存优惠应以 Router 账单为准。

可选价格表格式：

```json
{"input": 500000, "output": 1000000, "source": "catalog snapshot date and source"}
```

数值单位为 micro-USD / 百万 token。上述例子表示输入 $0.50 / 百万、输出 $1.00 / 百万，仅演示单位。估算不处理未记录的缓存优惠、工具费等，不能当真实账单。

`Task` 必填 id、scope、prompt、goal、budgetMicroUsd。mode 为 adaptive 或 compare；compare 在额度允许时要求所有硬性可用候选参与对照；额度不足以完成全量对照时优先兜底交付，并保留实际激活记录，不声称已经完成全量比较。每个任务接收完整模型输出后交付。Jev 最多调用 limits.maxDecisionCalls 次；普通选择阶段每个候选最多执行一次，之后允许一次兜底生成。Jev 的选择不受独立质量标签否决，无法选定时走 fallbackModel；结果 delivery.via 区分 jev / fallback，评价和测试事实单独保留。提前保留兜底预算；预算只够兜底时直接调用。兜底渠道失败时返回已有完整答案，所有渠道均无完整答案才返回执行失败。

生成型 judge 按固定结构评审匿名产物；无效/缺失评审保留未知，不恢复代码质量分。未配 judge 时 Jev 按明确的要求满足问题判断。复杂程序正确性需要宿主测试/独立验证，不依赖自评作证明。

经验 scope、最大年龄、模型版本与评价版本可追溯。完整历史内容按最大上下文大小选取，过大的案例整条跳过并留下检索记录，不悄悄将截断结果当完整成功。向量近邻只负责召回，是否适用由 Jev 判断。
