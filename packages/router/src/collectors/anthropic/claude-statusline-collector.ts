import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Account } from "../../domain/account.js";
import type { UsageSnapshot, UsageWindow } from "../../domain/usage.js";
import { normalizeUsage } from "../normalizer.js";
import type { UsageCollector } from "../types.js";

// Written by a user's Claude Code status line script from its rate_limits payload.
export const CLAUDE_QUOTA_MAX_AGE_MS = 30 * 60_000;
/** Extra used quota applied to an exact Claude observation retained past its normal cache age. */
export const CLAUDE_STALE_USED_MARGIN = 0.1;
/** A retained five-hour / weekly observation must not claim a reset beyond these windows. */
export const CLAUDE_FIVE_HOUR_RESET_MAX_MS = 5 * 60 * 60_000;
export const CLAUDE_WEEKLY_RESET_MAX_MS = 7 * 24 * 60 * 60_000;
const MIN_NONEXHAUSTED_REMAINING_RATIO = 0.0001;

const LimitSchema = z.object({
  used_percentage: z.number(),
  resets_at: z.number().positive().optional(),
});

const CacheSchema = z.object({
  at: z.number().positive(),
  error: z.unknown().optional(),
  certainty: z.string().optional(),
  five_hour: LimitSchema.optional(),
  seven_day: LimitSchema.optional(),
});

export function defaultClaudeQuotaCachePath(home = os.homedir()): string {
  return path.join(home, ".claude", "statusline-quota-cache.json");
}

function limitWindow(
  kind: UsageWindow["kind"],
  limit: z.infer<typeof LimitSchema>,
  usedMargin = 0,
): UsageWindow {
  const resetsAtMs = limit.resets_at === undefined ? undefined : limit.resets_at * 1000;
  const used = limit.used_percentage + usedMargin * 100;
  // A safety margin estimates additional use; it must not turn a non-exhausted observation
  // into proof that the quota is exhausted.
  const cappedUsed =
    limit.used_percentage < 100 && used >= 100
      ? 100 - MIN_NONEXHAUSTED_REMAINING_RATIO * 100
      : used;
  const usedPercent = Math.max(0, Math.min(100, cappedUsed));
  return {
    kind,
    remainingRatio: (100 - usedPercent) / 100,
    usedRatio: usedPercent / 100,
    ...(resetsAtMs === undefined ? {} : { resetsAt: new Date(resetsAtMs).toISOString() }),
  };
}

export function createClaudeStatuslineCollector(
  options: { cachePath?: string; now?: () => number; maxAgeMs?: number } = {},
): UsageCollector {
  const cachePath = options.cachePath ?? defaultClaudeQuotaCachePath();
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? CLAUDE_QUOTA_MAX_AGE_MS;

  function unknown(account: Account): UsageSnapshot {
    const at = new Date(now()).toISOString();
    return normalizeUsage({
      accountId: account.id,
      windows: [{ kind: "five-hour" }],
      collectedAt: at,
      source: "local-session",
      certainty: "unknown",
      expiresAt: at,
    });
  }

  return {
    kind: "local-session",
    async detectAccounts() {
      return [];
    },
    async collectUsage(account) {
      let cache;
      try {
        cache = CacheSchema.safeParse(JSON.parse(await readFile(cachePath, "utf8")));
      } catch {
        return unknown(account);
      }
      if (!cache.success || cache.data.error !== undefined || cache.data.certainty === "unknown") {
        return unknown(account);
      }
      const nowMs = now();
      const collectedAtMs = cache.data.at * 1000;
      if (collectedAtMs > nowMs) {
        return unknown(account);
      }
      const stale = nowMs - collectedAtMs > maxAgeMs;
      const fiveHour = cache.data.five_hour;
      const weekly = cache.data.seven_day;
      const fiveHourResetsAtMs =
        fiveHour?.resets_at === undefined ? undefined : fiveHour.resets_at * 1000;
      const weeklyResetsAtMs =
        weekly?.resets_at === undefined ? undefined : weekly.resets_at * 1000;
      const preservedExpiresAtMs =
        fiveHourResetsAtMs === undefined || weeklyResetsAtMs === undefined
          ? undefined
          : Math.min(fiveHourResetsAtMs, weeklyResetsAtMs);
      const fiveHourResetWithinBound =
        fiveHourResetsAtMs !== undefined &&
        fiveHourResetsAtMs <= collectedAtMs + CLAUDE_FIVE_HOUR_RESET_MAX_MS;
      const weeklyResetWithinBound =
        weeklyResetsAtMs !== undefined &&
        weeklyResetsAtMs <= collectedAtMs + CLAUDE_WEEKLY_RESET_MAX_MS;
      const preserved =
        stale &&
        Number.isFinite(maxAgeMs) &&
        maxAgeMs > 0 &&
        cache.data.certainty === "exact" &&
        fiveHour !== undefined &&
        weekly !== undefined &&
        preservedExpiresAtMs !== undefined &&
        preservedExpiresAtMs > nowMs &&
        fiveHourResetWithinBound &&
        weeklyResetWithinBound;
      if (stale && !preserved) {
        return unknown(account);
      }
      const windows: UsageWindow[] = [];
      if (fiveHour) {
        windows.push(limitWindow("five-hour", fiveHour, preserved ? CLAUDE_STALE_USED_MARGIN : 0));
      }
      if (weekly) {
        windows.push(limitWindow("weekly", weekly, preserved ? CLAUDE_STALE_USED_MARGIN : 0));
      }
      if (windows.length === 0) {
        return unknown(account);
      }
      return normalizeUsage({
        accountId: account.id,
        windows,
        collectedAt: new Date(collectedAtMs).toISOString(),
        source: "local-session",
        certainty: "estimated",
        expiresAt: new Date(
          preserved ? preservedExpiresAtMs : collectedAtMs + maxAgeMs,
        ).toISOString(),
        ...(preserved ? { stalePreserved: true } : {}),
      });
    },
    async listAvailableModels() {
      return [];
    },
  };
}
