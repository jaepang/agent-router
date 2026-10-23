import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Account } from "../../domain/account.js";
import type { UsageSnapshot } from "../../domain/usage.js";
import { normalizeUsage } from "../normalizer.js";
import type { UsageCollector } from "../types.js";

// Written by a user's Cursor agent status line script after it calls Cursor's usage API.
// The router only reads this file; it never handles the Cursor auth token.
export const CURSOR_QUOTA_MAX_AGE_MS = 30 * 60_000;

const CacheSchema = z.object({
  weekly_left: z.number().min(0).max(100),
  weekly_resets_at: z.number().optional(),
  pct: z.number().optional(),
  auto_left: z.number().optional(),
  at: z.number().positive(),
  error: z.unknown().optional(),
  certainty: z.string().optional(),
});

export function defaultCursorQuotaCachePath(home = os.homedir()): string {
  return path.join(home, ".cursor", "statusline-quota-cache.json");
}

export function createCursorStatuslineCollector(
  options: { cachePath?: string; now?: () => number; maxAgeMs?: number } = {},
): UsageCollector {
  const cachePath = options.cachePath ?? defaultCursorQuotaCachePath();
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? CURSOR_QUOTA_MAX_AGE_MS;

  function unknown(account: Account): UsageSnapshot {
    const at = new Date(now()).toISOString();
    return normalizeUsage({
      accountId: account.id,
      windows: [{ kind: "monthly" }],
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
      return normalizeUsage({
        accountId: account.id,
        windows: [
          {
            kind: "weekly",
            remainingRatio: cache.data.weekly_left / 100,
            usedRatio: 1 - cache.data.weekly_left / 100,
            ...(cache.data.weekly_resets_at
              ? { resetsAt: new Date(cache.data.weekly_resets_at * 1000).toISOString() }
              : {}),
          },
        ],
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
