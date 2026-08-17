import type { CGMReading, CGMState } from '@type1a/schemas';

export interface FreshnessResult {
  ageMinutes: number;
  state: Extract<CGMState, 'connected' | 'stale' | 'provider_error'>;
  isFutureTimestamp: boolean;
}

export function assessFreshness(
  sourceTimestamp: string,
  now = new Date(),
  staleAfterMinutes = 15,
): FreshnessResult {
  const sourceMs = Date.parse(sourceTimestamp);
  if (!Number.isFinite(sourceMs) || staleAfterMinutes <= 0) {
    throw new Error('Invalid timestamp or stale threshold.');
  }

  const rawAge = (now.getTime() - sourceMs) / 60_000;
  const isFutureTimestamp = rawAge < -2;
  const ageMinutes = Math.max(0, Math.floor(rawAge));

  if (isFutureTimestamp) {
    return { ageMinutes, state: 'provider_error', isFutureTimestamp };
  }

  return {
    ageMinutes,
    state: ageMinutes >= staleAfterMinutes ? 'stale' : 'connected',
    isFutureTimestamp,
  };
}

/**
 * The most recent reading that can legitimately stand in for "current
 * glucose" — i.e. never an imported historical row, no matter how recent
 * its `sourceTimestamp` happens to be. `readings` is expected sorted
 * ascending by `sourceTimestamp` (as `getCGMReadings` returns it).
 *
 * Without this, a same-day CSV import can leave a MySugr row young enough
 * to pass `assessFreshness`, and naive `readings.at(-1)` picks it as
 * "current" — which is exactly the "imported data presented as live"
 * failure AGENTS.md prohibits, and it would also get silently pre-filled
 * into the correction-dose calculator as though it came from a live CGM.
 * `origin: 'synthetic'` is intentionally NOT excluded here — it's a
 * legitimate "current" value for the dev/mock provider, just visibly
 * labelled as synthetic by the UI, unlike imported history.
 */
export function latestLiveReading(readings: readonly CGMReading[]): CGMReading | null {
  for (let i = readings.length - 1; i >= 0; i -= 1) {
    const reading = readings[i]!;
    if (reading.origin !== 'imported') return reading;
  }
  return null;
}
