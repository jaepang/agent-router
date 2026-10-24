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
  const usedPercent = Math.max(0, Math.min(100, used));
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
      const preserved =
        stale &&
        cache.data.certainty === "exact" &&
        cache.data.five_hour !== undefined &&
        cache.data.seven_day !== undefined &&
        cache.data.five_hour.resets_at !== undefined &&
        cache.data.seven_day.resets_at !== undefined &&
        cache.data.five_hour.resets_at * 1000 > nowMs &&
        cache.data.seven_day.resets_at * 1000 > nowMs;
      if (stale && !preserved) {
        return unknown(account);
      }
      const windows: UsageWindow[] = [];
      if (cache.data.five_hour) {
        windows.push(
          limitWindow("five-hour", cache.data.five_hour, preserved ? CLAUDE_STALE_USED_MARGIN : 0),
        );
      }
      if (cache.data.seven_day) {
        windows.push(
          limitWindow("weekly", cache.data.seven_day, preserved ? CLAUDE_STALE_USED_MARGIN : 0),
        );
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
          preserved
            ? Math.min(cache.data.five_hour!.resets_at!, cache.data.seven_day!.resets_at!) * 1000
            : collectedAtMs + maxAgeMs,
        ).toISOString(),
        ...(preserved ? { stalePreserved: true } : {}),
      });
    },
    async listAvailableModels() {
      return [];
    },
  };
}
