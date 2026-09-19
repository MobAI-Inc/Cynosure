// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(process.argv[2]);
const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8"));
const prices = JSON.parse(readFileSync("eval/runtime.json", "utf8")).routes;
const sourceFiles = (dir, prefix = "") =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const file = join(prefix, entry.name);
    if (entry.isDirectory())
      return [".git", "node_modules"].includes(entry.name) ? [] : sourceFiles(dir, file);
    return entry.isFile() && /\.(?:[cm]?jsx?|tsx?|py|sql)$/.test(entry.name) ? [file] : [];
  });
const priceCalls = (calls) => {
  let estimateMicroUsd = 0,
    unpricedCalls = 0;
  for (const call of calls) {
    if (call.charge.microUsd !== null) estimateMicroUsd += call.charge.microUsd;
    else {
      const p = prices.find((m) => m.id === call.model)?.pricing;
      if (p && call.charge.inputTokens !== null && call.charge.outputTokens !== null)
        estimateMicroUsd += Math.ceil(
          (call.charge.inputTokens * p.input + call.charge.outputTokens * p.output) / 1e6,
        );
      else unpricedCalls++;
    }
  }
  return { estimateMicroUsd, unpricedCalls };
};
const rows = [];
for (const name of readdirSync(join(root, "runs"))) {
  const dir = join(root, "runs", name),
    file = join(dir, "result.json");
  if (!existsSync(file)) continue;
  const result = JSON.parse(readFileSync(file, "utf8"));
  const dbfile =
    result.model === "auto"
      ? join(root, result.round.startsWith("pilot") ? result.round : "online", "experience.sqlite")
      : join(dir, "baseline.sqlite");
  const db = new DatabaseSync(dbfile, { readOnly: true });
  const tasks = db
    .prepare("SELECT id,body FROM tasks ORDER BY created")
    .all()
    .filter((r) => JSON.parse(r.body).sessionId === result.id);
  let pricebookEstimate = 0,
    unpricedCalls = 0;
  const errors = [];
  const selectedModels = [];
  let feedbackInDecisions = 0,
    externalChecksInDecisions = 0,
    emptyFirstEvidence = null;
  for (const task of tasks) {
    const calls = db
      .prepare("SELECT body FROM calls WHERE task_id=?")
      .all(task.id)
      .map((r) => JSON.parse(r.body));
    const priced = priceCalls(calls);
    pricebookEstimate += priced.estimateMicroUsd;
    unpricedCalls += priced.unpricedCalls;
    const events = db
      .prepare("SELECT kind,body FROM events WHERE task_id=? ORDER BY seq")
      .all(task.id)
      .map((e) => ({ ...e, body: JSON.parse(e.body) }));
    for (const e of events) {
      if (e.kind === "host-provider-failure") {
        const raw = e.body.error ?? "";
        const http = raw.match(/\b(400|401|402|403|404|429|500|502|503|504)\b/)?.[1] ?? "unknown";
        errors.push({
          model: e.body.route,
          http,
          reasoningHistoryRequired: raw.includes("reasoning_content"),
        });
      }
      if (e.kind === "decision") {
        const exp = e.body.state.experience ?? [];
        if (emptyFirstEvidence === null) emptyFirstEvidence = exp.length === 0;
        if (exp.some((x) => x.feedback?.length)) feedbackInDecisions++;
        if (exp.some((x) => x.feedback?.some((f) => f.source === "host-regression")))
          externalChecksInDecisions++;
      }
    }
    const row = db.prepare("SELECT result FROM tasks WHERE id=?").get(task.id);
    const outcome = row?.result ? JSON.parse(row.result) : null;
    if (outcome?.selectedModel) selectedModels.push(outcome.selectedModel);
  }
  const changed = [];
  const base = join(root, "snapshots", result.case, "base");
  const code = join(dir, "code");
  const immutableTest = cases.find((c) => c.id === result.case).test ?? "__cynosure.test.ts";
  for (const target of [...new Set([...sourceFiles(base), ...sourceFiles(code)])]
    .filter((p) => p !== immutableTest)
    .sort()) {
    const a = join(base, target),
      b = join(code, target);
    const before = existsSync(a) ? readFileSync(a) : null,
      after = existsSync(b) ? readFileSync(b) : null;
    if (!before || !after || !before.equals(after)) {
      changed.push(target);
      const diff = spawnSync("diff", ["-u", before ? a : "/dev/null", after ? b : "/dev/null"], {
        encoding: "utf8",
      }).stdout;
      writeFileSync(join(dir, `${target.replaceAll("/", "__")}.patch`), diff);
    }
  }
  let finalAnswer = false;
  for (const line of readFileSync(join(dir, "pi.jsonl"), "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type === "message_end" && e.message?.role === "assistant")
        finalAnswer = e.message.stopReason === "stop";
    } catch {}
  }
  rows.push({
    ...result,
    selectedModels,
    errors,
    emptyFirstEvidence,
    feedbackInDecisions,
    externalChecksInDecisions,
    pricebookEstimateMicroUsd: pricebookEstimate,
    unpricedCalls,
    changed,
    finalAnswer,
  });
  db.close();
}
const formal = rows.filter((r) => !r.round.startsWith("pilot"));
const expected = cases.length * 6;
const expectedIds = cases.flatMap((c) => [
  `cold-${c.id}-auto`,
  `repeat-${c.id}-auto`,
  ...prices.map((m) => `fixed-${c.id}-${m.id}`),
]);
const missing = expectedIds.filter((id) => !formal.some((r) => r.id === id));
const integrity = [];
for (const name of readdirSync(join(root, "runs"))) {
  const dir = join(root, "runs", name);
  const item = cases.find((c) => name.includes(c.id));
  if (!item) continue;
  const reference = item.test
    ? join(root, "snapshots", item.id, "base", item.test)
    : resolve("scripts/live-coding/cocos-regressions.test.ts");
  const actual = join(dir, "code", item.test ?? "__cynosure.test.ts");
  const unchanged = existsSync(actual) && readFileSync(reference).equals(readFileSync(actual));
  integrity.push({ id: name, unchanged });
}
writeFileSync(join(root, "test-integrity.json"), JSON.stringify(integrity, null, 2));
const excluded = [];
const recoveryFile = join(root, "recovery.json");
if (existsSync(recoveryFile)) {
  const recovery = JSON.parse(readFileSync(recoveryFile, "utf8"));
  const db = new DatabaseSync(resolve(recovery.backup), { readOnly: true });
  for (const id of recovery.excludedSessions) {
    const calls = db
      .prepare(
        "SELECT c.body FROM calls c JOIN tasks t ON t.id=c.task_id WHERE json_extract(t.body,'$.sessionId')=?",
      )
      .all(id)
      .map((r) => JSON.parse(r.body));
    excluded.push({ id, reason: recovery.reason, calls: calls.length, ...priceCalls(calls) });
  }
  db.close();
}
const paired = cases.map((c) => {
  const cold = formal.find((r) => r.id === `cold-${c.id}-auto`);
  const repeat = formal.find((r) => r.id === `repeat-${c.id}-auto`);
  return { case: c.id, cold: cold ?? null, repeat: repeat ?? null };
});
const groups = ["auto", ...prices.map((m) => m.id)].map((model) => {
  const items = formal.filter((r) => r.model === model);
  return {
    model,
    completed: items.length,
    checksPassed: items.filter((r) => r.checksPassed).length,
    completeDelivery: items.filter((r) => r.checksPassed && r.finalAnswer).length,
    generations: items.reduce((n, r) => n + r.generations, 0),
    decisionCalls: items.reduce((n, r) => n + r.decisionCalls, 0),
    estimateMicroUsd: items.reduce((n, r) => n + r.pricebookEstimateMicroUsd, 0),
    unpricedCalls: items.reduce((n, r) => n + r.unpricedCalls, 0),
  };
});
const originals = [...new Set(cases.map((c) => c.repo))].map((repo) => {
  const reference = cases.find((c) => c.repo === repo);
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const diff = spawnSync("git", ["-C", repo, "diff", "HEAD", "--binary"]).stdout;
  return {
    repo,
    unchangedHead: head === reference.originalHead,
    unchangedTrackedWork:
      createHash("sha256").update(diff).digest("hex") === reference.originalDiffSha256,
  };
});
const analysis = {
  at: new Date().toISOString(),
  complete: formal.length === expected && !missing.length && integrity.every((r) => r.unchanged),
  completed: formal.length,
  expected,
  originals,
  missing,
  integrity,
  excluded,
  paired,
  groups,
  rows,
};
writeFileSync(join(root, "analysis.json"), JSON.stringify(analysis, null, 2));
const out = process.argv[3] ?? join(root, "report.md");
const lines = [
  "# Pi 真实代码任务：零经验与在线反馈",
  "",
  `更新时间：${analysis.at}；正式轨迹 ${formal.length}/${expected}。`,
  "",
  "对象为 Moonshort Cocos 客户端与后端的四个历史缺陷。白名单仅导出源码，未复制依赖、素材、环境文件、数据库、构建产物或原 Git 历史；未修改原项目或全局 Pi 配置，未安装依赖。",
  "",
  "## 方法与证据边界",
  "",
  "每个模型从独立旧版本源码副本开始，由本机 Pi 读代码、编辑和执行同一组外部回归检查。四个固定模型各执行四个任务；Cynosure 首轮从空 SQLite 开始，连续四个任务后，再从原始缺陷副本重复四题。只有在线组自己的实际工具结果和外部检查回流在线库，固定组不向它提供经验。",
  "",
  "Cocos 使用 Vitest 检查历史修复要求及轻量 cc 环境替身；后端复用修复提交中的既有属性槽测试、OAuth Worker 测试。它们分别已在旧版失败、历史修复版通过。没有运行 Creator、设备、后端服务或数据库；结果只代表这些代码行为。重复同题检验经验复用，不能证明未见任务泛化或长期收敛。",
  "",
  "Pi 个别轨迹自行扩展到全量检查，遇到未复制的 Prisma 生成文件、Worker 部署配置等环境失败。这些输出保留在真实反馈中，相关调用、耗时和费用照计；表中回归通过只指实验开始前固定的目标检查，不代表整个原项目全量验证通过。",
  "",
  "运行中完成了 Pi 跨模型 DeepSeek reasoning_content 兼容修复；早期协议错误保留在记录中。这批是在线集成与对照验证，不作为冻结运行时的严格模型排名。第一版实验目录的沙箱/测试启动故障单列，不并入以下正式成绩。",
  "",
  "恢复前发现首轮 OAuth 轨迹读取了机器临时目录中的既有修复源码，该轨迹及随后部分执行的重测已排除并留档，费用仍保留。在线库通过 SQLite 备份后只移除这两条轨迹，保留前三个有效任务；后续从独立旧版副本重新执行。恢复后的命令默认禁止文件读取，仅放行本份代码、检查器和运行库，原路径与 /System/Volumes/Data 别名均已探测阻止；四个旧/修复版本在同一沙箱重新验证通过。早期有效轨迹的命令已检查，未发现同类外部修复读取，但其隔离强度与恢复后不同。",
  "",
  "实验配置 runtime.json 恢复时保持原样；提供商价格表只用于报告中有用量部分的事后估算，没有加入这一批的决策状态。因而本批不能充分验证价格驱动的收敛。正式使用的配置已包含价格元数据，属于提供商事实，并非模型能力评分。",
  "",
  "## 整体结果",
  "",
  "| 路径 | 完成轨迹 | 产物通过检查 | 检查通过且有完整结尾 | 生成 / Jev | 可计价部分美元 | 未计价调用 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...groups.map(
    (g) =>
      `| ${g.model === "auto" ? "Cynosure（首轮+同题重测）" : g.model} | ${g.completed} | ${g.checksPassed} | ${g.completeDelivery} | ${g.generations} / ${g.decisionCalls} | ${(g.estimateMicroUsd / 1e6).toFixed(4)} | ${g.unpricedCalls} |`,
  ),
  "",
  "Cynosure 包含四题各两次，固定组每题一次；在线组可调用多个候选并在渠道故障后尝试其他模型。原始通过数不可直接当作等调用预算的模型能力排名。",
  "",
  "## 单任务结果",
  "",
  "| 任务 | 路径 | 回归检查 | 完整结尾回复 | 轮次 / 工具 | 生成 / Jev | 秒 | 可计价部分估计美元 | 未计价调用 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
for (const r of formal)
  lines.push(
    `| ${r.case} | ${r.model === "auto" ? `Cynosure ${r.round}` : r.model} | ${r.checksPassed ? "通过" : "未通过"} | ${r.finalAnswer ? "有" : "无"} | ${r.turns} / ${r.toolCalls} | ${r.generations} / ${r.decisionCalls} | ${(r.elapsedMs / 1000).toFixed(1)} | ${(r.pricebookEstimateMicroUsd / 1e6).toFixed(4)} | ${r.unpricedCalls} |`,
  );
lines.push(
  "",
  "费用为已回报金额加明确价格表对有 token 用量部分的估算，缺失调用没有按零价计算。它不是总账单。多候选、Jev、embedding 均计入，模型内部推理 token 以实际用量为准。",
  "",
  "## 同题经验复用对照",
  "",
  "| 任务 | 首轮 / 重测检查 | 生成调用 | 工具次数 | 秒 | 可计价部分美元 |",
  "| --- | --- | --- | --- | --- | --- |",
);
for (const { case: id, cold, repeat } of paired) {
  if (!cold || !repeat) {
    lines.push(`| ${id} | 尚未完成配对 | — | — | — | — |`);
    continue;
  }
  lines.push(
    `| ${id} | ${cold.checksPassed ? "通过" : "失败"} / ${repeat.checksPassed ? "通过" : "失败"} | ${cold.generations} / ${repeat.generations} | ${cold.toolCalls} / ${repeat.toolCalls} | ${(cold.elapsedMs / 1000).toFixed(1)} / ${(repeat.elapsedMs / 1000).toFixed(1)} | ${(cold.pricebookEstimateMicroUsd / 1e6).toFixed(4)} / ${(repeat.pricebookEstimateMicroUsd / 1e6).toFixed(4)} |`,
  );
}
lines.push(
  "",
  "首轮和重测使用相同提示与全新缺陷副本；重测继承真实在线历史。这允许复用先前解法，不能把省下的调用全部解释为学到了普适模型偏好，也没有通过关闭反馈的消融实验确立因果关系。",
  "",
  "## 反馈是否进入下一次选择",
  "",
  "| 任务 | 首次无经验 | 决策读到宿主反馈次数 | 决策读到外部回归结果次数 | 实际交付轮次的模型 |",
  "| --- | --- | --- | --- | --- |",
);
for (const r of formal.filter((r) => r.model === "auto"))
  lines.push(
    `| ${r.case} / ${r.round} | ${r.emptyFirstEvidence ? "是" : "否"} | ${r.feedbackInDecisions} | ${r.externalChecksInDecisions} | ${[...new Set(r.selectedModels)].map((m) => `${m} × ${r.selectedModels.filter((x) => x === m).length}`).join("；")} |`,
  );
lines.push(
  "",
  "以上证明反馈可被实际决策读取，不单独证明反馈导致了质量或成本改善。不存在人工赋予的模型能力分数或预载训练集。工具执行状态不自动当成任务成功，外部回归结果明确属于整条轨迹。",
  "",
  "## 渠道与执行问题",
  "",
);
for (const r of formal.filter((r) => r.errors.length))
  lines.push(
    `- ${r.id}：${r.errors.map((e) => `${e.model} HTTP ${e.http}${e.reasoningHistoryRequired ? "（跨模型推理历史字段）" : ""}`).join("；")}。`,
  );
lines.push(
  "",
  "503 或协议错误导致的未交付与已产代码的功能失败必须分别解释；成功生成但没有通过检查也不能归为渠道故障。",
  "",
  "## 原环境核对",
  "",
  `- 不可变检查文件：${integrity.filter((r) => r.unchanged).length}/${integrity.length} 保持一致。`,
  `- 尚未完成的正式轨迹：${missing.length ? missing.join("、") : "无"}。`,
);
for (const original of originals)
  lines.push(
    `- ${original.repo}：HEAD ${original.unchangedHead ? "未变" : "有变化"}，已跟踪工作区内容 ${original.unchangedTrackedWork ? "未变" : "有变化，需核查来源"}。`,
  );
lines.push(
  "",
  "## 排除记录及费用",
  "",
  ...excluded.map(
    (r) =>
      `- ${r.id}：排除，${r.calls} 次调用，可计价部分约 $${(r.estimateMicroUsd / 1e6).toFixed(4)}，另有 ${r.unpricedCalls} 次费用未知。原始日志、改动与恢复前 SQLite 保留在 quarantine/。`,
  ),
  "",
  `详细证据：${root}/analysis.json 与 runs/ 中的 input、Pi 事件、SQLite、检查日志和补丁。`,
  "",
);
writeFileSync(out, lines.join("\n"));
console.log(
  JSON.stringify({
    completed: formal.length,
    expected,
    complete: analysis.complete,
    report: out,
    originals,
  }),
);
