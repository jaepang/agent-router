import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Account } from "../../domain/account.js";
import type { UsageSnapshot } from "../../domain/usage.js";
import { normalizeUsage } from "../normalizer.js";
import type { UsageCollector } from "../types.js";

// Written by a user's Codex status line (or a small script). The router only reads this file.
export const CODEX_QUOTA_MAX_AGE_MS = 30 * 60_000;

const CacheSchema = z.object({
  weekly_left: z.number().optional(),
  five_hour: z.object({ used_percentage: z.number(), resets_at: z.number().optional() }).optional(),
  seven_day: z.object({ used_percentage: z.number(), resets_at: z.number().optional() }).optional(),
  at: z.number().positive(),
  error: z.unknown().optional(),
  certainty: z.string().optional(),
});

export function defaultCodexQuotaCachePath(home = os.homedir()): string {
  return path.join(home, ".codex", "statusline-quota-cache.json");
}

export function createCodexStatuslineCollector(
  options: { cachePath?: string; now?: () => number; maxAgeMs?: number } = {},
): UsageCollector {
  const cachePath = options.cachePath ?? defaultCodexQuotaCachePath();
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? CODEX_QUOTA_MAX_AGE_MS;

  function unknown(account: Account): UsageSnapshot {
    const at = new Date(now()).toISOString();
    return normalizeUsage({
      accountId: account.id,
      windows: [{ kind: "weekly" }],
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
      const collectedAtMs = cache.data.at * 1000;
      if (collectedAtMs > now() || now() - collectedAtMs > maxAgeMs) {
        return unknown(account);
      }
      const weekly = cache.data.seven_day?.used_percentage;
      const weeklyLeft = weekly === undefined ? cache.data.weekly_left : 100 - weekly;
      if (weeklyLeft === undefined && !cache.data.five_hour) return unknown(account);
      const left = weeklyLeft === undefined ? undefined : Math.max(0, Math.min(100, weeklyLeft));
      const windows: UsageSnapshot["windows"] = [];
      for (const [kind, block] of [
        ["five-hour", cache.data.five_hour],
        ["weekly", cache.data.seven_day],
      ] as const) {
        if (block)
          windows.push({
            kind,
            remainingRatio: Math.max(0, Math.min(1, 1 - block.used_percentage / 100)),
            usedRatio: Math.max(0, Math.min(1, block.used_percentage / 100)),
            ...(block.resets_at
              ? { resetsAt: new Date(block.resets_at * 1000).toISOString() }
              : {}),
          });
      }
      if (!cache.data.seven_day && left !== undefined)
        windows.push({ kind: "weekly", remainingRatio: left / 100, usedRatio: (100 - left) / 100 });
      return normalizeUsage({
        accountId: account.id,
        windows,
        collectedAt: new Date(collectedAtMs).toISOString(),
        source: "local-session",
        certainty: "estimated",
        expiresAt: new Date(collectedAtMs + maxAgeMs).toISOString(),
      });
    },
    async listAvailableModels() {
      return [];
    },
  };
}
