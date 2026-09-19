<div align="center">

# Cynosure

**Jev-Based Decision Architecture for LLMs and Coding Agents**

Jev decides. Code orchestrates. Experience informs.

[English](README.md) · [简体中文](README.zh-CN.md)

![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square)
![SQLite + sqlite-vec](https://img.shields.io/badge/SQLite-sqlite--vec-40B5AD?style=flat-square)
[![Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-7C6AE8?style=flat-square)](LICENSE)

Built by **MobAI Inc.**

[Quick Start](#quick-start) · [Benchmarks](#local-benchmark-results) · [Architecture](#architecture) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

</div>

Cynosure is **Jev-based by design**: an adaptive model router built around Jev's [Native Choice](https://docs.typesafe.ai/primitives/choice) primitive. Jev selects which candidate to invoke, whether to compare more outputs, and which result to deliver, within the executable actions defined by code. Hybrid retrieval and real execution feedback supply evidence to this **Jev decision loop**; the runtime enforces budgets, concurrency, and fallback handling. Start with an empty experience store—no router-model training or hand-maintained model quality matrix required.

## Local benchmark results

**85.4% test pass rate. +14.6 percentage points over the best single-model baseline. 50% fewer failed trials.**

Using official tasks and unmodified tests from [Aider Polyglot](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f), with the test-and-repair procedure described in [Aider benchmark](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/benchmark), we ran 24 Python tasks twice each. Cynosure passed **41/48** trials versus **34/48** for GLM 5.3 Flash, the best fixed single-model baseline in this run: **7 additional passing trials** and a **20.6% relative improvement** in pass rate.

| Metric | Reference | Cynosure | Improvement |
| --- | ---: | ---: | ---: |
| Python final pass rate | Best single model: 70.8% | **85.4%** | **+14.6 pp** |
| Python failed trials | Best single model: 14/48 | **7/48** | **50.0% fewer** |
| Pi total task wall time | Initial run: 1,351.2 s | Repeat: **733.9 s** | **45.7% lower** |
| Pi generation calls | Initial run: 72 | Repeat: **55** | **23.6% fewer** |

**Real defect repair with Pi: 100% target regression pass rate, 8/8 trials.** Both the initial and repeated four-task runs passed 4/4. The repeat run retained prior experience and cut total task wall time nearly in half while maintaining all regression passes. Seven of eight trials also completed the final response, including 4/4 in the repeat run.

These are local measurements on the Aider Polyglot Python subset and four Pi defect-repair tasks. The Python comparison uses multi-model routing versus fixed single-model execution; the Pi comparison uses initial versus same-task repeat runs. [Full results and methodology](docs/validation.md) include generation counts and experimental conditions. Large-scale production performance, unseen-task generalization, and long-term cost savings remain to be validated.

## Why Cynosure

| Capability | What it delivers |
| --- | --- |
| **Jev Decision Core** | Native Choice drives model selection, candidate comparison, and result delivery through a finite, executable action space. |
| **Retrieval-Augmented Decisions** | Supplies Jev with task outcomes, tool observations, and user corrections as evidence for subsequent decisions. |
| **Hybrid Retrieval + RRF** | Combines vector similarity and SQLite FTS5 lexical search with Reciprocal Rank Fusion, scoped by project, time, and embedding revision. |
| **Budget-Constrained Orchestration** | Atomic budget reservations, bounded parallel candidate execution, and explicit fallback handling keep scheduling in code. |
| **Host-Native Tool Execution** | The Pi adapter hands one selected proposal to the host; actual tool results feed subsequent routing decisions. |
| **Traceable Experience + Cost Ledger** | SQLite persists task provenance, decision evidence, call usage, and feedback, with reported, estimated, and unknown costs recorded separately. |

One Node.js runtime. One runtime dependency. Persistent local experience. **No router-model training required.**

## Architecture

![Cynosure: a Jev decision core supported by bounded model execution and persistent experience](docs/assets/architecture.svg)

The diagram separates three logical planes within the runtime:

- **Jev Decision Plane:** Jev selects executable actions using the task, candidate outputs, and retrieved experience; code enforces budget and concurrency constraints.
- **Execution Plane:** Router adapters invoke model candidates; the decision loop inspects outputs; the application or Pi host receives the selected answer or tool proposal.
- **Experience Plane:** actual tool results, external checks, and user corrections join the trace ledger and retrieval index, forming a persistent feedback loop.

The application owns tool execution. Jev owns semantic action selection. The runtime owns scheduling and accounting. See the [architecture reference](docs/architecture.md) and [technical foundations](docs/research/open-source.md).

The decision contract follows TypeSafe's [System One design](https://docs.typesafe.ai/concepts/how-to-build-with-system-one): narrow, structured model judgments within code-owned control flow. Related work includes [RouteLLM](https://arxiv.org/abs/2406.18665), [Reciprocal Rank Fusion](https://doi.org/10.1145/1571941.1572114), and [ReAct](https://arxiv.org/abs/2210.03629), informing the routing, retrieval, and feedback mechanisms around the Jev core.

## Quick start

Use Node.js 24+ from the source checkout and set `MOB_AI_API_KEY` in your local `.env`. Candidate models, Jev, and embeddings are accessed through Mob AI Router.

```sh
npm ci
npm start -- run config/router.example.json config/task.example.json
npm start -- inspect coding-cold-001
npm start -- feedback coding-cold-001 config/feedback.example.json
```

This runs a task, inspects its recorded outcome, and appends feedback. Use a new task ID for another run. See [configuration](docs/configuration.md) for model IDs, pricing, and budget settings.

### Use with Pi

```sh
npm run build
node --env-file-if-exists=.env scripts/pi.mjs /absolute/path/to/your-project
```

The launcher uses your installed Pi with `cynosure/auto`, records actual tool results, and reuses experience within the same project scope. See the [Pi integration guide](docs/integrations/pi.md).

## Documentation and contributing

The [Chinese README](README.zh-CN.md) covers the same capabilities and results. Detailed guides are currently in Chinese.

- [Project overview](docs/overview.md): capabilities and use cases.
- [Architecture](docs/architecture.md): decisions, execution, and feedback.
- [Technical foundations](docs/research/open-source.md): implementation choices and upstream references.
- [Runtime guide](docs/runtime.md): platforms, storage, budgets, and host requirements.
- [Roadmap](ROADMAP.md): upcoming integrations and validation work.

Contributions to adapters, independent task sets, benchmark reproduction, and implementation are welcome. Development checks:

```sh
npm run check
npm run check:docs
npm run check:package
```

Version **0.2.0**. Local benchmarks, 27 core tests, and package installation checks completed.

## License

[Apache-2.0](LICENSE) · Copyright 2026 **MobAI Inc.**
