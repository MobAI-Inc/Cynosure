# Cynosure 文档

Cynosure 0.2.0 采用 Jev-based Design，为 LLM 应用和 Coding Agent 提供以 Jev 为决策核心的自适应模型路由。

[English README](../README.md) · [中文 README](../README.zh-CN.md) · MobAI Inc.

## 开始使用

| 文档 | 内容 |
| --- | --- |
| [项目介绍](overview.md) | 产品能力、使用场景与实测收益 |
| [快速开始](../README.zh-CN.md#快速开始) | 运行任务、查看结果和提交反馈 |
| [配置说明](configuration.md) | 候选模型、预算、检索和执行参数 |
| [Router 接入](integrations/mob-ai-router.md) | 生成、embedding 与 Decisions 接口 |
| [Pi 接入](integrations/pi.md) | 在 Coding Agent 中使用 Cynosure |

## 深入了解

| 文档 | 内容 |
| --- | --- |
| [架构设计](architecture.md) | Jev 决策核心、动作空间、检索证据与执行约束 |
| [运行说明](runtime.md) | 运行平台、数据存储、预算与宿主要求 |
| [技术基础与开源生态](research/open-source.md) | 相关论文、组件选择与固定版本源码参考 |
| [基准实测](validation.md) | 85.4% 通过率、单模型对照与 Pi 效率提升 |
| [实验操作](../eval/README.md) | 准备和运行代码任务实验 |
| [路线图](../ROADMAP.md) | 后续功能与验证方向 |

## 参与贡献

欢迎贡献任务样例、接入适配、文档与代码。请阅读[贡献指南](../CONTRIBUTING.md)和[安全说明](../SECURITY.md)。

每个主题维护一份当前文档；参数和行为随实现更新，实验数字保留来源与适用范围。文档链接及数据元信息可通过 `npm run check:docs` 检查。
