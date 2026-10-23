import type { Account } from "../domain/account.js";
import type { ModelProfile } from "../domain/model-profile.js";
import type { UsageSnapshot } from "../domain/usage.js";
import { isFresh } from "./freshness.js";
import { projectedRemainingRatio, remainingRatio } from "./quota.js";
import { roundRatio } from "./ratio.js";

export type ExclusionReason =
  | "cursor-model-forbidden"
  | "account-disabled"
  | "stale-usage"
  | "unknown-usage"
  | "below-reserve"
  | "quota-exhausted"
  | "model-not-enabled";

export type EligibilityResult =
  | { eligible: true; projectedRemainingRatio: number }
  | { eligible: false; reason: ExclusionReason; projectedRemainingRatio?: number };

export interface EligibilityInput {
  account: Account;
  model: ModelProfile;
  usage: UsageSnapshot;
  estimatedCostRatio: number;
  now: Date;
  usageMaxAgeMs?: number;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  if (input.model.agent === "cursor" && /claude|gpt|gemini/i.test(input.model.launchName)) {
    return { eligible: false, reason: "cursor-model-forbidden" };
  }
  if (!input.account.enabled) {
    return { eligible: false, reason: "account-disabled" };
  }
  if (!input.account.enabledModels.includes(input.model.id)) {
    return { eligible: false, reason: "model-not-enabled" };
  }
  const personal = input.account.ownership === "personal";
  if (!isFresh(input.usage, input.now, input.usageMaxAgeMs)) {
    return { eligible: false, reason: "stale-usage" };
  }
  const pool = input.model.quotaPool;
  const remaining = remainingRatio(input.usage, pool);
  if (remaining !== undefined && remaining <= 0) {
    return { eligible: false, reason: "quota-exhausted", projectedRemainingRatio: remaining };
  }
  const projected = projectedRemainingRatio(input.usage, input.estimatedCostRatio, pool);
  if (projected === undefined) {
    return { eligible: false, reason: "unknown-usage" };
  }
  const roundedProjected = roundRatio(projected);
  if (!personal && roundedProjected < input.account.reserveFloor) {
    return { eligible: false, reason: "below-reserve", projectedRemainingRatio: roundedProjected };
  }
  return { eligible: true, projectedRemainingRatio: roundedProjected };
}
