// SPDX-License-Identifier: Apache-2.0
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Verdict = "met" | "partial" | "unmet" | "unknown";

/** Prices are integer micro-USD per million tokens, from an explicit pricebook. */
export interface Model {
  id: string;
  revision: string;
  maxInputBytes: number;
  /** Provider capability ceiling, not a per-request generation budget. */
  outputTokenLimit?: number;
  reserveMicroUsd: number;
  pricing?: { input: number; output: number; source: string };
}
export interface Config {
  router: { baseUrl: string; apiKeyEnv: string };
  jev: Model;
  embedding: Model;
  routes: Model[];
  fallbackModel: string;
  judge?: Model;
  limits: {
    timeoutMs: number;
    maxDecisionCalls: number;
    maxParallel: number;
    maxResponseBytes: number;
    maxEvidenceBytes: number;
  };
  memory: { topK: number; maxAgeDays: number };
  auditRate: number;
}
/** v0.2 handles complete text requests. Hosts report full task/tool outcomes separately. */
export interface Task {
  id: string;
  scope: string;
  prompt: string;
  goal: string;
  budgetMicroUsd: number;
  mode?: "adaptive" | "compare";
  /** Actual host state for this decision; never a precomputed model ranking. */
  context?: Json;
  sessionId?: string;
}
export interface HostReply {
  output: string;
  charge: Charge;
  observation?: Json;
}
export type HostGenerate = (task: Task, route: Model, runId: string) => Promise<HostReply>;
export interface Charge {
  microUsd: number | null;
  basis: "reported" | "estimated" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface Call {
  id: string;
  taskId: string;
  kind: "embedding" | "decision" | "generation" | "judge";
  model: string;
  revision: string;
  reservation: number;
  state: "reserved" | "ok" | "failed";
  charge: Charge;
  elapsedMs: number;
  error: string | null;
}
export interface Run {
  id: string;
  route: string;
  revision: string;
  callId: string;
  status: "complete" | "failed";
  output: string | null;
  error: string | null;
  elapsedMs: number;
  charge: Charge;
  toolCalls: number | null;
  observationScope: "request";
  observation?: Json;
}
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
}
export interface Decision {
  callId: string;
  stage: "initial" | "result";
  questionVersion: string;
  evidenceIds: string[];
  state: Json;
  questions: Record<string, ChoiceQuestion>;
  answers: Record<string, ChoiceAnswer>;
}
export interface Evaluation {
  runId: string;
  verdict: Verdict;
  evidence: string;
  judge: string;
  judgeRevision: string;
  rubricVersion: string;
  callId: string;
}
export interface Feedback {
  source: string;
  verdict: Verdict;
  note: string;
  runId?: string;
  toolCalls?: number;
  scope: "request" | "task";
  observation?: Json;
  receivedAt?: string;
}
export interface Experience {
  id: string;
  prompt: string;
  goal: string;
  createdAt: string;
  status: string;
  candidates: Model[];
  runs: Run[];
  evaluations: Evaluation[];
  feedback: Feedback[];
  totals: Totals;
}
export interface Totals {
  reportedMicroUsd: number;
  estimatedMicroUsd: number;
  unknownCalls: number;
  committedMicroUsd: number;
  calls: number;
}
export interface Result {
  taskId: string;
  status: "delivered" | "stopped" | "failed";
  output: string | null;
  selectedRunId: string | null;
  selectedModel: string | null;
  evidenceIds: string[];
  runIds: string[];
  totals: Totals;
  error: string | null;
  delivery?: { via: "jev" | "fallback"; reason?: string };
}
export const UNKNOWN_CHARGE: Charge = {
  microUsd: null,
  basis: "unknown",
  inputTokens: null,
  outputTokens: null,
};
