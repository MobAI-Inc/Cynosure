# 架构设计

Cynosure 0.2.0 · MobAI Inc.

Cynosure 的核心设计是 **Jev-based Decision Architecture**：以 Jev Native Choice 作为路由的语义决策核心，围绕它组织候选执行、经验检索和真实反馈。模型选择、追加比较与结果交付通过同一组结构化动作表达，代码负责构造可行动作、约束资源并执行状态转换。

这一设计直接采用 TypeSafe [System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one) 的分工：将范围明确的判断交给模型，将控制流程与副作用保留在代码中。**Jev 决策，代码编排，经验提供依据。** Retrieval-Augmented Routing 是向 Jev 提供相关任务证据的机制。

[RouteLLM](https://arxiv.org/abs/2406.18665) 将请求相关的模型选择用于质量与成本权衡，[FrugalGPT](https://arxiv.org/abs/2305.05176) 进一步讨论模型组合与级联执行。Cynosure 在这一问题框架下采用 **Budget-Constrained Sequential Decision-Making**：每一步结合当前任务、已产生的候选结果和相关经验，从代码构造的可执行动作中选择下一步。适应发生在请求上下文与经验层，首条请求即可从空库运行。

## 系统分层

![Cynosure：决策、执行与经验三个逻辑层的反馈闭环](assets/architecture.svg)

| 逻辑层 | 核心机制 | 交付给下一层的信息 |
| --- | --- | --- |
| **Jev Decision Plane** | Jev Native Choice、有限动作空间、检索增强证据 | 选中的候选执行、追加比较、交付或兜底动作 |
| **Execution Plane** | Provider Adapter、有界并发、宿主原生工具执行 | 完整候选输出、调用状态与实际工具观察 |
| **Experience Plane** | Transactional Ledger、反馈来源记录、版本化检索 | 可追溯的任务案例与后续决策证据 |

三个 Plane 是同一运行时内的逻辑职责。Jev 承担语义判断，TypeScript 代码承担状态转换与执行约束，Router 提供模型服务，Pi 等宿主执行选中的工具提案。这种职责分离与 [TypeSafe 的 Choice 接口](https://docs.typesafe.ai/primitives/choice)相匹配，也便于独立替换模型服务和宿主接入。

## Jev 决策核心：有限动作空间与增量证据

每次路由维护五类状态：任务目标与宿主上下文、可用候选、已产生的输出、检索经验、剩余预算。代码先依据输入兼容性、调用预留和已执行候选生成 **Feasible Action Set**，再交给 Jev 选择。

| 动作 | 作用 | 代码约束 |
| --- | --- | --- |
| `run_i` | 执行一个尚未尝试的候选 | 输入兼容，且预算覆盖生成与后续决策 |
| `compare_all` | 对剩余候选进行直接比较 | 检查合计预留额度，通过 `maxParallel` 限制并发 |
| `deliver_i` | 交付已有的完整结果 | 候选必须处于完成状态 |
| `fallback` | 将当前请求交给配置的兜底路径 | 保留兜底额度并记录触发原因 |

Jev 通过 Native Choice 返回动作、选项概率与可用的 confidence。适配器检查选项集合、概率范围和分布总和，随后保存完整状态、问题版本、经验 ID 与原始回答，形成 **Decision Provenance**。

同一状态下的独立问题可以批量求值；依赖新生成结果的判断进入下一步。每次执行产生的新输出、费用和观察更新决策上下文，因此路由能够先尝试一个候选，再决定追加比较或交付。普通模型负责生成内容，Jev 的结构化选择由代码映射为明确的控制流。

## 经验检索：Hybrid Retrieval 与 RRF

[RAG](https://arxiv.org/abs/2005.11401) 展示了将外部记忆作为推理条件的设计方式。Cynosure 将这一思路用于路由证据：检索对象是包含目标、候选、输出、评价和反馈的完整任务案例，构成 **Non-parametric Experience Memory**。新经验通过写入与检索进入后续决策，无需更新路由模型权重。

检索使用两条互补通道：

- **Dense Retrieval：** embedding 与 cosine distance 查找语义相近的任务。
- **Lexical Retrieval：** SQLite FTS5 的 trigram 索引与 BM25 排序匹配任务中的名称、符号和术语。

两路结果采用 Cormack 等人在 SIGIR 2009 提出的 [Reciprocal Rank Fusion](https://doi.org/10.1145/1571941.1572114) 合并。当前实现使用从 1 开始的排名，`k = 60`：

$$
\operatorname{RRF}(e)=\sum_{r\, :\, e\in r}\frac{1}{60+\operatorname{rank}_r(e)}
$$

按排名融合可直接组合不同检索器的结果，无需将 cosine distance 与 BM25 分数校准到同一量纲。[Graphiti 的混合检索实现](https://github.com/getzep/graphiti/blob/4a6cd47dc4e5754e4f8d430a081c542bfe847296/graphiti_core/search/search_config_recipes.py#L33)也采用 BM25、cosine similarity 与 RRF 的组合。Cynosure 用融合结果确定案例的检索优先级，再由 Jev 结合当前任务解释案例内容。

### 检索范围与上下文预算

**Scope-aware Retrieval** 按项目 scope 和时间窗口选择已结束任务，并排除当前任务。向量通道额外匹配 embedding 模型版本与维度；词法通道可独立工作。缓存键包含 scope、embedding space 和查询摘要，便于同一项目复用有效向量。

每个通道最多召回 `4 × topK` 条记录，经 RRF 合并后保留 `topK` 个案例。送入决策前，再按 `maxEvidenceBytes` 选择能够完整容纳的案例，保留每条案例的任务、输出与反馈上下文。Embedding 不可用时，检索路径降级为 FTS5，并留下事件记录。

## 执行与反馈：Observation-Driven Adaptation

[ReAct](https://arxiv.org/abs/2210.03629) 将行动与环境观察组织为交替过程；[Reflexion](https://arxiv.org/abs/2303.11366) 研究通过语言反馈和 episodic memory 改进后续尝试。Cynosure 借鉴其中的 **Action–Observation Loop** 和经验复用思路，将宿主实际执行结果作为后续模型选择的上下文。

在 Pi 中，一个路由请求对应 Agent 的一个轮次。候选模型提出回答或工具调用，Cynosure 选择一个提案，Pi 执行读文件、编辑或命令操作。扩展监听 `tool_result`，保存工具名、参数、错误状态和结果；后续用户输入、显式反馈和外部回归检查也可以追加到对应任务。

这里的经验更新是 **Retrieval-mediated Adaptation**：保留执行观察与纠正，在后续相关请求中检索使用。候选结果的比较仍由 Jev 完成，宿主保留自己的工具循环和上下文管理。

### 轨迹归因与数据来源

反馈保留 source、scope、接收时间、宿主 session 与可用的 run ID，形成 **Trajectory-level Attribution**。请求级工具结果关联实际执行分支，任务级验收关联整条执行轨迹。`agent_end` 记录运行结束，用户验收由显式反馈或外部检查补充。

任务、模型评价与执行观察分别保存，便于复查某次动作基于哪些证据产生。[GEPA 的 adapter 合同](https://github.com/gepa-ai/gepa/blob/15ee314f9c7d34ec153b809d401f42f55c4dcd76/src/gepa/core/adapter.py#L15)同样区分输出、评价和执行轨迹，为这一数据分工提供工程参考。

## 资源控制：Transactional Budget Accounting

每个付费调用先执行 **Reserve → Execute → Settle**。预算准入使用整数 micro-USD，在同一数据库事务中检查并写入预留：

```text
committedMicroUsd + reserveMicroUsd ≤ budgetMicroUsd
```

Node.js 存储适配器采用 SQLite `BEGIN IMMEDIATE`，将额度检查与调用登记放入同一写事务，避免并行候选基于同一份剩余额度重复获准。这对应 [SQLite 的事务语义](https://www.sqlite.org/lang_transaction.html)。

实际账目分别记录 `reported`、`estimated` 与 `unknown`。估算值和未知费用仍保留相应预算占用；提供商回报费用超过预留时，记录超额并停止继续扩展候选。因此，预算约束明确作用于调用准入，账本同时保留实际计费结果。

### 有界并发与交付路径

**Bounded Fan-Out** 将多候选执行限制在 `maxParallel` 以内；决策次数、输入容量和证据容量分别由配置约束。路由为兜底预留预算，额度仅够兜底时直接执行对应路径。决策或提供商异常进入显式回退，已有完整结果仍可用于交付。

文本 CLI 缓冲生成流，完成后交付完整回答；Pi 交付完整文本或单个选中分支的工具提案。每次实际模型调用均记录费用、耗时和状态。与 [vLLM Semantic Router 的 Looper](https://github.com/vllm-project/semantic-router/blob/0f8bd239a169f4c83d1decf42dd47b01a7f22fb7/src/semantic-router/pkg/looper/looper.go#L119)类似，观察对象覆盖整个执行过程，能够同时查看候选调用与端到端行为。

## 数据合同与实现位置

| 记录 | 保存内容 | 用途 |
| --- | --- | --- |
| **Task** | 请求、目标、scope、候选与配置摘要 | 固定本次执行的上下文 |
| **Decision** | 状态、问题版本、经验引用与原生回答 | 解释动作选择及其来源 |
| **Call / Run** | 预留、费用、耗时、执行状态与输出 | 调用记账与结果交付 |
| **Evaluation** | `met / partial / unmet / unknown` 及依据 | 保存要求满足情况 |
| **Feedback** | 来源、作用范围、实际观察与纠正 | 更新可检索的任务经验 |
| **Experience** | 任务、执行、评价与反馈的聚合 | 为后续请求提供案例上下文 |

| 组件 | 实现位置 | 职责 |
| --- | --- | --- |
| 决策与调度 | `src/router.ts` | 可行动作构造、Jev 调用、候选执行与交付 |
| 提供商协议 | `src/providers.ts` | 生成、embedding、Decisions、完整流接收与费用解析 |
| 经验与账目核心 | `src/store-core.ts` | 任务、事件、预算预留、混合检索与反馈 |
| SQLite 适配 | `src/store.ts` | Node.js SQLite、事务、WAL 与 sqlite-vec 加载 |
| 经验标识与向量 | `src/store-utils.ts` | 摘要、embedding space 与向量校验 |
| 配置与类型 | `src/config.ts`、`src/types.ts` | 输入合同、版本与执行参数 |
| CLI 与 Pi | `src/cli.ts`、`integrations/pi/index.ts` | 文本任务入口、宿主生成与反馈回流 |

## 评测与延伸阅读

代码任务采用 Aider 官方题目和测试，通过 promptfoo 执行固定模型与 Cynosure 对照。当前本地 Python 子集通过率为 **85.4%**，领先本次最佳单模型对照 **14.6 个百分点**；Pi 同题重测的生成调用减少 **23.6%**、任务耗时降低 **45.7%**。完整口径见[基准实测](validation.md)。

论文说明相关机制与研究背景，Cynosure 的效果数字来自自身运行记录。参考文献、固定版本源码和选型说明见[技术基础与开源生态](research/open-source.md)；大规模生产、未见任务泛化与长期成本收益见[后续验证计划](../ROADMAP.md)。
