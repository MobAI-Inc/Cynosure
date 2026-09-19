# Coding 验证

本页介绍本地代码基准的复现步骤。产品运行不需要种子题；通过率与对照结果见[基准实测](../docs/validation.md)，后续方向见[路线图](../ROADMAP.md)。

只使用 Aider Polyglot 固定提交里的 34 道 Python 题和未修改的官方 pytest。10 道学习、24 道独立验证；固定四个模型与 Cynosure（Fusion）对照，主要验证重复两次。框架为 promptfoo 0.123.1；生成完整文件、执行官方测试、最多修复一次，沿用 Aider 的验证方式。

这是 Router 适配版本，不是完整 Aider leaderboard harness。Cynosure 优先交付，评价不设拦截闸门；无法判别或决策异常时用配置的 Grok 4.6 兜底。一轮可能激活多个模型，必须同时报告实际生成、测试和 Jev 次数，以及耗时和费用。不能只比较“首轮通过率”。

## 固定候选与对照口径

Fusion 的生成候选固定为 `grok-4.6`、`deepseek-v4-flash`、`glm-5.3`、`glm-5.3-flash`；四个单模型组分别使用其中一个。`typesafe/jev-1.13` 负责决策，`jina-embeddings-v5-text-small` 负责经验检索，二者费用也属于 Fusion 的运行开销。模型及价格快照见 [runtime.json](runtime.json)。

`provider.mjs` 通过 `observeRun` 对每份完整候选代码执行官方测试，再把结果交给后续路由决策。一次路由可以测试多个候选；最多两次交付尝试不等于最多两次生成。比较时应同时阅读生成次数、决策次数、embedding 次数与[成本覆盖](../docs/benchmarks/costs.md)。

## 运行

使用 Node.js 24；安装 promptfoo 原生依赖和执行时的 Node 主版本须一致。`npm ci`，并在本机 `.env` 提供 `MOB_AI_API_KEY`。Python 执行器要求 `.cynosure/tools/benchmark/bin/python`（Python 3.12、pytest 8.4.2），当前隔离依赖 macOS sandbox-exec。

选一个新的输出目录，旧目录有数据库时拒绝重复付费调用：

```sh
npm run eval:prepare -- .cynosure/coding-run
npm run eval:run -- .cynosure/coding-run learn
node --env-file-if-exists=.env scripts/eval/seed.mjs .cynosure/coding-run
npm run eval:run -- .cynosure/coding-run heldout-1
npm run eval:run -- .cynosure/coding-run heldout-2
node scripts/eval/analyze.mjs .cynosure/coding-run
python3 scripts/eval/render-report.py .cynosure/coding-run
```

promptfoo 因测试失败返回非零退出码是数据，不等于执行器故障；先确认学习矩阵有完整 40 条记录再冻结 seed。正式 heldout 每个任务使用 seed 的独立副本，只有同一任务修复时能使用自己的前一轮结果。重复运行不应使用同一个输出目录。

## 配置和证据

- `plan.json`：固定来源、方法、允许模型、重复次数和预算。
- `coding-cases.json`：学习/验证题目选择，全部为 coding。
- `runtime.json`：四个候选的参数、价格来源与 Jev/embedding；不预设模型质量排名。
- 默认生成 262,144 token；按模型真实输出能力封顶，GLM 5.3 / Flash 为 131,072。没有任务级 token 调参项。流式接收，3,600 秒请求超时。
- 输出目录内 `*.rows.jsonl` 保留完整观测；各 trial SQLite 保留 Jev 输入、动作、检索经验和费用。`analysis.json` 检查矩阵缺口、重复记录、跨任务经验泄漏、交付与官方测试是否一致。
- 费用区分 reported / estimated / unknown；冻结经验中复制的历史调用不是新费用，不能重复相加。

正式基准不展示参考实现或测试源码。官方参考实现仅用于执行器验收；测试观察可进入候选选择，失败信息也会在交付修复阶段提供。源文件逐项校验和、配置、代码快照、seed 校验和应随正式运行归档。两次重复和短 Python 文件不证明长期收敛或大型仓库任务优越性。

学习批次已启动时，可以运行 `node scripts/eval/complete.mjs .cynosure/coding-run` 顺序完成冻结经验、两轮验证与结果文档。它不重试或重跑已有付费 trial，缺失/重复记录会停止批次并写入输出目录的 `pipeline.json`。结果文档写入同一目录的 `report.md`，不覆盖项目验证汇总。每道任务内部仍按交付优先策略执行。
