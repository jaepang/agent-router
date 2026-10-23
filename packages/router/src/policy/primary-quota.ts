import type { Account } from "../domain/account.js";
import type { UsageSnapshot } from "../domain/usage.js";
import { isFresh } from "./freshness.js";
import { remainingRatio } from "./quota.js";

/** Cursor unlocks only on confirmed weekly exhaustion of both primary CLIs. */
export function primaryQuota(
  accounts: Account[],
  usage: Record<string, UsageSnapshot>,
  now: Date,
  maxAgeMs?: number,
) {
  const resets: string[] = [];
  const states = ["codex", "claude-code"].map((agent) => {
    const rows = accounts.filter((a) => a.enabled && a.agent === agent).map((a) => usage[a.id]);
    if (rows.some((s) => s && isFresh(s, now, maxAgeMs) && (remainingRatio(s) ?? 0) > 0))
      return "available";
    if (
      !rows.length ||
      rows.some((s) => !s || !isFresh(s, now, maxAgeMs) || remainingRatio(s) === undefined)
    )
      return "unknown";
    if (rows.every((s) => s!.windows.some((w) => w.kind === "weekly" && w.remainingRatio === 0)))
      return "weekly";
    for (const s of rows) {
      for (const w of s!.windows) {
        if (
          w.kind !== "weekly" &&
          w.remainingRatio === 0 &&
          w.resetsAt &&
          Date.parse(w.resetsAt) > now.getTime()
        )
          resets.push(w.resetsAt);
      }
    }
    return "short-term";
  });
  return {
    cursorAllowed: states.every((s) => s === "weekly"),
    status: states.includes("unknown") ? "usage-unavailable" : "quota-wait",
    reason: `Primary quota: codex=${states[0]}, claude-code=${states[1]}. Cursor requires both weekly limits.`,
    retryAt: resets.sort((a, b) => Date.parse(a) - Date.parse(b))[0],
  };
}
