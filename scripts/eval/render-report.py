#!/usr/bin/env python3
"""Render recorded benchmark facts; never score or call a model."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
report = json.loads((root / 'analysis.json').read_text())
target = Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'report.md'
labels = {'grok-4.6':'Grok 4.6','deepseek-v4-flash':'DeepSeek V4 Flash','glm-5.3':'GLM 5.3','glm-5.3-flash':'GLM 5.3 Flash','cynosure':'Cynosure'}
def duration(ms): return '—' if ms is None else f'{ms/1000:.1f}'
def usd(m): return f"{m['reportedUsd']:.6f} / {m['estimatedUsd']:.6f}"
completed = report['integrity']['expectedHeldout'] - len(report['integrity']['missingHeldout'])
state = '完成' if report['complete'] else '运行中，以下不是最终结论'
lines = [f'# Cynosure coding 对照实验：模型能力与交付优先', '', f"状态：{state}。生成时间 {report['generatedAt']}。学习 {report['integrity']['learningRows']}/40；独立验证 {completed}/240。", '',
'使用 Aider Polyglot 固定版本 24 道 Python 场景、440 个官方测试；promptfoo 执行四个固定模型与 Cynosure 的两次重复。学习题另选10道，不重合。每次任务最多一轮修复。生成请求默认262,144 tokens，GLM5.3与Flash按模型能力封顶131,072，费用预留与3,600秒请求超时单独记录。', '',
'完整候选代码由不变的官方测试验收，测试源与参考实现不进入模型输入。只有测试错误日志可以用于下一轮修复。方法是 Aider 的 Router 适配，不声称等价未修改的 Aider leaderboard harness。', '',
'本表是带冻结种子的外部对照条件，既不是系统启动条件，也不是模型永久能力表。产品支持空库直接运行；项目当前小范围验证汇总见源码树中的 docs/validation.md。', '',
'## 实际可用性与结果', '',
'“完整代码任务”表示至少有一份可送测输出；“最终通过”要求交付答案通过该题所有官方测试。未取得完整代码的渠道错误保留在端到端分母中，但不能解释为模型能力差。', '',
'| 组 | 已完成 | 完整代码任务 | 首轮通过 | 最终通过（含修复） | 通过任务中位耗时(s) | 全部任务P95(s) | reported / estimated USD | 未知费用调用 |',
'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for arm,m in report['heldout'].items():
 lines.append(f"| {labels[arm]} | {m['n']} | {m['trialsWithExecutableCode']} | {m['firstPass']} | {m['finalPass']} | {duration(m['successfulMedianMs'])} | {duration(m['p95Ms'])} | {usd(m)} | {m['unknownCalls']} |")
lines += ['', '固定模型首轮一次生成；Cynosure 首轮是一次路由循环，可能执行多个模型。不能把二者首轮指标当作等调用量比较。费用包含失败及修复，未知费用不当作免费；estimated 来自显式目录价，不是实际账单。', '',
'| 组 | 生成调用 | Jev调用 | Embedding调用 | 测试次数 | 修复后通过任务 | 输出token峰值 |',
'| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
for arm,m in report['heldout'].items():
 lines.append(f"| {labels[arm]} | {m['generationCalls']} | {m['decisionCalls']} | {m['embeddingCalls']} | {m['testRuns']} | {m['repaired']} | {m['outputTokenMax']} |")
lines += ['', '## 24场景结果', '', '各格为最终通过次数/完成次数；预计每格2次。参数或渠道失败也计入完成次数，失败类型见下一节。', '',
'| 场景 | Grok | DS Flash | GLM | GLM Flash | Cynosure |', '| --- | ---: | ---: | ---: | ---: | ---: |']
for case in report['scenarios']:
 lines.append('| '+case['case']+' | '+' | '.join(f"{case['arms'][arm]['finalPass']}/{case['arms'][arm]['n']}" for arm in labels)+' |')
lines += ['', '## 失败类型与路由审计', '']
for arm,m in report['heldout'].items():
 errors='；'.join(f'{k} × {v}' for k,v in m['callErrors'].items()) or '暂无调用错误'
 lines.append(f"- {labels[arm]}：{errors}；产生过代码但最终未通过 {m['unsuccessfulTrialsWithExecutableCode']} 任务；测试超时 {m['testTimeouts']} 次；导入/收集测试异常 {m['testCollectionErrors']} 次。")
a=report['routing'];r=a['retrievals']
lines += ['', f"Jev 决策 {sum(a['decisions'].values())} 次；读取经验 {len(r)} 次；候选检索后因容量等排除 {sum(x['retrieved']-x['selected'] for x in r)} 条次；完全没有经验的检索 {sum(x['selected']==0 for x in r)} 次。跨验证任务读取经验 {len(a['crossTrialEvidence'])} 条。", '',
f"已交付但测试失败答案 {a['deliveredFailingTest']} 次；已有测试通过产物却未交付 {a['passingOutputWithoutDelivery']} 轮。Jev 测试判断记录：`{json.dumps(a['qualityAgainstTests'],ensure_ascii=False)}`。", '',
f"初次动作：`{json.dumps(a['initialChoices'],ensure_ascii=False)}`。选项run_0至run_3依次对应Grok、DS Flash、GLM、GLM Flash，compare_all执行剩余候选。", '',
f"全部动作：`{json.dumps(a['decisions'],ensure_ascii=False)}`。", '',
'## 不确定性与边界', '',
'按场景聚类的配对bootstrap保留两次重复；下表是Cynosure减去对应固定组的最终通过率差，未完整的场景不参与。该区间只描述这24题的重采样波动，不代表整个coding工作负载。', '',
'| 对照 | 完整场景数 | 通过率差 | 配对场景bootstrap95%区间 |','| --- | ---: | ---: | --- |']
for arm,p in report['pairedScenarioBootstrap'].items():
 delta='—' if p['successRateDifference'] is None else f"{p['successRateDifference']*100:+.1f} pp"
 ci='—' if p['scenarioBootstrap95'] is None else ' ~ '.join(f'{v*100:+.1f} pp' for v in p['scenarioBootstrap95'])
 lines.append(f"| {labels[arm]} | {p['completeScenarios']} | {delta} | {ci} |")
lines += ['',
'公开题可能存在训练集重合；这里只验证短Python文件，未覆盖大型仓库修改、跨语言或完整Agent工具链。部分题检验精确异常信息和接口习惯，报告只能按实际官方测试定义解读。', '',
'冻结经验避免跨题污染，但不验证长期在线收敛；没有无经验路由消融，不能单凭有经验的路由表现宣称经验导致收益。费用、耗时、成功率分别展示，不发明统一质量分。provider排队、上游缓存与实际渠道回退未完全受控；第二次倒序只能减轻固定顺序影响。', '',
'本表只使用当前结果目录内的批次。生成输出按模型能力封顶；评价不否决答案，无法决策时使用配置的兜底模型，额外调用均计费计次。', '',
'## 证据', '',
f'- [完整结果]({root}/analysis.json)', f'- [冻结配置和种子校验和]({root}/manifest.json)',
f'- [官方预期样例]({root}/official-example-tests.json)', f'- [各次执行数据库和测试报告]({root}/runs)',
f'- [学习观测]({root}/learn.rows.jsonl)', f'- [第一轮观测]({root}/heldout-1.rows.jsonl)',f'- [第二轮观测]({root}/heldout-2.rows.jsonl)',
'- [Aider Polyglot 固定提交](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f)',
'- [Aider 验证方法固定提交](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/benchmark)', '']
target.write_text('\n'.join(lines));print(target.resolve())
