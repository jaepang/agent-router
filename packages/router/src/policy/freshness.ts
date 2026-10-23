import type { UsageSnapshot } from "../domain/usage.js";

export const DEFAULT_USAGE_MAX_AGE_MS = 30 * 60_000;

export function isFresh(
  snapshot: UsageSnapshot,
  now: Date,
  maxAgeMs = DEFAULT_USAGE_MAX_AGE_MS,
): boolean {
  const age = now.getTime() - Date.parse(snapshot.collectedAt);
  return (
    Number.isFinite(maxAgeMs) &&
    maxAgeMs > 0 &&
    age >= 0 &&
    age <= maxAgeMs &&
    Date.parse(snapshot.expiresAt) > now.getTime()
  );
}
