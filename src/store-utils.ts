// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { Model } from "./types.ts";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const embeddingSpace = (m: Model) => `${m.id}@${m.revision}`;
export function vector(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 65_536 ||
    value.some(
      (n) => typeof n !== "number" || !Number.isFinite(n) || !Number.isFinite(Math.fround(n)),
    ) ||
    !value.some((n) => n !== 0)
  )
    throw new Error("Invalid embedding");
  return value;
}
