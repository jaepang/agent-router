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
    const knownRows = rows.filter((snapshot): snapshot is UsageSnapshot => snapshot !== undefined);
    if (
      !rows.length ||
      knownRows.length !== rows.length ||
      knownRows.some(
        (snapshot) => !isFresh(snapshot, now, maxAgeMs) || remainingRatio(snapshot) === undefined,
      )
    )
      return "unknown";
    // Preserved values are deliberately pessimistic estimates, not evidence of confirmed exhaustion.
    if (knownRows.some((snapshot) => snapshot.stalePreserved)) return "unknown";
    if (knownRows.some((snapshot) => (remainingRatio(snapshot) ?? 0) > 0)) return "available";
    if (
      knownRows.every((snapshot) =>
        snapshot.windows.some((w) => w.kind === "weekly" && w.remainingRatio === 0),
      )
    )
      return "weekly";
    for (const snapshot of knownRows) {
      for (const w of snapshot.windows) {
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
