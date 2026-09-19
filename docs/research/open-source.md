# 技术基础与开源生态

Cynosure 以 **Jev-based Design** 为架构主线，直接采用 Jev Native Choice 完成有限动作中的语义选择。混合检索与真实反馈为 Jev 提供证据，Router、SQLite 和 Agent 宿主分别承接模型服务、持久化与工具执行。

本文整理当前设计的研究背景与工程来源：6 篇相关论文、11 个开源仓库、27 份固定版本源码或文档。核对日期为 2026-09-19；文献元信息、完整提交及源码文件校验和见 [sources.json](sources.json)。

## 研究脉络

| 设计问题 | 相关研究 | 在 Cynosure 中的落点 |
| --- | --- | --- |
| 如何为请求选择模型与执行路径 | RouteLLM [1]、FrugalGPT [2]：query-dependent routing 与模型组合中的质量—成本权衡 | Jev 在预算允许的候选执行、追加比较、交付与兜底之间选择动作 |
| 如何融合语义与词法检索 | Reciprocal Rank Fusion [3]：通过排名聚合多路检索结果 | 对 cosine distance 与 FTS5/BM25 两路结果执行 RRF，`k = 60` |
| 如何让新信息参与推理 | Retrieval-Augmented Generation [4]：将外部非参数化记忆作为推理条件 | 检索完整任务经验，将目标、产物和反馈共同提供给决策模型 |
| 如何利用实际执行观察 | ReAct [5]：交替组织行动与环境观察 | Pi 执行选中工具提案，`tool_result` 回流后续模型选择 |
| 如何跨次保留反馈 | Reflexion [6]：语言反馈与 episodic memory | 以有来源的任务案例保存工具结果、纠正和外部检查，通过检索复用 |

路由部分采用 Jev 的结构化判断，经验更新采用运行时记录与检索。RRF 是当前直接实现的算法；其余论文提供问题框架与机制参考。具体状态、动作和数据合同见[架构设计](../architecture.md)。

## 直接使用的能力

| 能力 | 当前采用方式 |
| --- | --- |
| 决策核心 | Jev Native Choice；遵循 TypeSafe System One 的结构化判断与代码控制分工 |
| 模型服务 | 通过现有 Mob AI Router 使用生成、embedding 与 Decisions 接口 |
| 本地存储 | Node.js 内置 SQLite，事务记录任务、调用与反馈 |
| 向量与全文检索 | sqlite-vec 0.1.9、SQLite FTS5 与 RRF |
| 开发评测 | promptfoo 0.123.1 与固定版本的代码测试 |
| Agent 工具 | Pi 宿主执行选中工具提案，扩展回传实际结果 |

## 设计参考

| 项目与固定版本 | 参考机制 | 对 Cynosure 的启发 |
| --- | --- | --- |
| [RouteLLM · 0b64fdaf](https://github.com/lm-sys/RouteLLM/tree/0b64fdafe049e596a3f5657c219329f24af24198) | 查询相关经验、强弱模型路由与固定基线 | 将路由结果放回具体任务和资源条件中比较 |
| [vLLM Semantic Router · 0f8bd239](https://github.com/vllm-project/semantic-router/tree/0f8bd239a169f4c83d1decf42dd47b01a7f22fb7) | Looper、多候选并发和全调用 usage | 统一记录执行路径、调用次数与总开销 |
| [Plano · 003c36ae](https://github.com/katanemo/plano/tree/003c36aea896ce6fa98567329588baa582e41f9c) | 声明式配置及编排、模型管理、观测分工 | 清楚划分应用、宿主与路由层的职责 |
| [Aurelio Semantic Router · 6a8b7a0c](https://github.com/aurelio-labs/semantic-router/tree/6a8b7a0cd40613dee2e240f3e00d3e11430ffaa9) | 路线文本编码与语义索引 | 使用向量语义查找相关信息，保持路由接口清晰 |
| [LiteLLM · b8d837b2](https://github.com/BerriAI/litellm/tree/b8d837b2ef04da6953a93d136c69eb3980bcb34d) | 提供商适配、重试、兜底和通道冷却 | 继续复用已有网关的供应商与渠道能力 |
| [promptfoo · 32b79fd9](https://github.com/promptfoo/promptfoo/tree/32b79fd98a4cb86d633069412f528ad5c8142bbc) | 自定义 provider、实验矩阵与 assertion | 将实验执行与运行时解耦，单独记录选择与任务满足情况 |
| [Aider · 5dc9490b](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | 代码产物、固定测试与隔离运行 | 用实际可执行产物检验代码任务 |
| [GEPA · 15ee314f](https://github.com/gepa-ai/gepa/tree/15ee314f9c7d34ec153b809d401f42f55c4dcd76) | 执行轨迹、反思材料与独立候选评价 | 为后续反馈分析和离线优化保留有用的信息 |
| [Graphiti · 4a6cd47d](https://github.com/getzep/graphiti/tree/4a6cd47dc4e5754e4f8d430a081c542bfe847296) | 混合检索、RRF、来源与事实有效期 | 将相关性、来源和时间信息一起用于案例检索 |
| [sqlite-vec · 04d28bd2](https://github.com/asg017/sqlite-vec/tree/04d28bd21773981e2d266bbf6aa4efbd011eb4f6) | 嵌入 SQLite 的向量运算 | 在一个本地数据栈中完成持久化与向量检索 |
| [Vowpal Wabbit · 63317862](https://github.com/VowpalWabbit/vowpal_wabbit/tree/63317862be157d30615236eb3154f55f1dfaf1d5) | 选择性观察与策略评价 | 区分实际执行结果和未观察候选，设计明确的对照实验 |

表中区分直接使用与设计参考；实际软件依赖以 package-lock 为准。Plano 使用当前仓库名称，原 `katanemo/archgw` 已重定向至该仓库。

## 判断与执行的分工

Jev 原生 [Choice](https://docs.typesafe.ai/primitives/choice)返回有限选项及概率，符合 [System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)所描述的“模型判断、代码控制流程”。Cynosure 将这一接口用于候选执行、追加对照和结果交付。Jev 作为模型服务调用，生成和工具执行分别由对应模型及宿主承担。

[vLLM 的 Looper](https://github.com/vllm-project/semantic-router/blob/0f8bd239a169f4c83d1decf42dd47b01a7f22fb7/src/semantic-router/pkg/looper/looper.go#L100)集中描述实际使用模型、调用次数、总 usage 和整个循环的墙钟时延。Cynosure 同样围绕完整执行过程记录事实，为多候选任务提供统一的观察入口。

## 经验检索与反馈

[RRF 原论文](https://doi.org/10.1145/1571941.1572114)给出按排名融合的算法与 `k = 60` 的实验设置；[Graphiti 的混合检索配方](https://github.com/getzep/graphiti/blob/4a6cd47dc4e5754e4f8d430a081c542bfe847296/graphiti_core/search/search_config_recipes.py#L33)提供了 BM25、向量相似度和 RRF 组合的工程实现。[来源与时效字段](https://github.com/getzep/graphiti/blob/4a6cd47dc4e5754e4f8d430a081c542bfe847296/graphiti_core/edges.py#L263)也展示了经验保留上下文的价值。

Cynosure 使用关系清晰的任务、调用和反馈记录组织案例，并按 scope、embedding 版本和时间窗口检索。向量检索负责找到相关材料，Jev 结合任务目标和实际反馈进行选择。无需更新模型权重即可将新记录带入决策。

[GEPA 的 adapter](https://github.com/gepa-ai/gepa/blob/15ee314f9c7d34ec153b809d401f42f55c4dcd76/src/gepa/core/adapter.py#L15)将输出、评价和轨迹作为不同信息保存。这一分工有助于反馈分析；Cynosure 当前使用案例检索，GEPA 和 Graphiti 均为设计参考。

## 独立实验与实际产物

[promptfoo 的 provider 接口](https://github.com/promptfoo/promptfoo/blob/32b79fd98a4cb86d633069412f528ad5c8142bbc/examples/provider-custom/typescript/customProvider.ts)便于连接实际调用协议，[Aider 的 benchmark](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/benchmark/README.md#L8)使用可执行产物和测试检查代码行为。Cynosure 采用这类方法组织本地基准评测，并保留任务满足情况与相对选择各自的记录。

[RouteLLM 的路由接口](https://github.com/lm-sys/RouteLLM/blob/0b64fdafe049e596a3f5657c219329f24af24198/routellm/routers/routers.py#L32)与 [VW 的策略评价方法](https://github.com/VowpalWabbit/vowpal_wabbit/blob/63317862be157d30615236eb3154f55f1dfaf1d5/python/docs/source/tutorials/off_policy_evaluation.md#L12)为后续固定基线和探索实验提供参考。

这些来源解释技术机制与设计选择；Cynosure 的通过率、调用与耗时结果见[基准实测](../validation.md)。与其他框架的性能对比、长期收益及生产表现列入后续验证。

## 参考文献

1. Ong, I., et al. (2024). **RouteLLM: Learning to Route LLMs with Preference Data.** arXiv:2406.18665. [论文](https://arxiv.org/abs/2406.18665)。用于请求相关的模型选择与质量—成本权衡。
2. Chen, L., Zaharia, M., & Zou, J. (2023). **FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance.** arXiv:2305.05176. [论文](https://arxiv.org/abs/2305.05176)。用于模型组合与级联执行的研究背景。
3. Cormack, G. V., Clarke, C. L. A., & Buettcher, S. (2009). **Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods.** SIGIR 2009. [DOI](https://doi.org/10.1145/1571941.1572114) · [作者公开全文](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)。用于当前两路检索的排名融合。
4. Lewis, P., et al. (2020). **Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.** NeurIPS 2020. [论文](https://arxiv.org/abs/2005.11401)。用于外部记忆与推理上下文的设计参考。
5. Yao, S., et al. (2022). **ReAct: Synergizing Reasoning and Acting in Language Models.** arXiv:2210.03629. [论文](https://arxiv.org/abs/2210.03629) · [项目](https://react-lm.github.io/)。用于行动与环境观察的交替组织。
6. Shinn, N., et al. (2023). **Reflexion: Language Agents with Verbal Reinforcement Learning.** NeurIPS 2023. [会议论文](https://proceedings.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html)。用于语言反馈与情景记忆的机制参考。
