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
 * Readings that can legitimately stand in for "live/current" data — i.e.
 * never imported historical rows, no matter how recent their
 * `sourceTimestamp` happens to be. `origin: 'synthetic'` is intentionally
 * KEPT — it's a legitimate "current" value for the dev/mock provider,
 * just visibly labelled as synthetic by the UI, unlike imported history.
 *
 * `origin: 'manual'` is also KEPT, and that is a deliberate decision (see
 * `isSensorReading` for the other half of it). A glucose the user measured
 * and typed in a minute ago genuinely is their current value — more current
 * than an older sensor reading — so excluding it would make the correction
 * calculator ignore the freshest number available. What must NOT happen is
 * the reverse: a manual value being *attributed to the sensor*. It carries
 * no provider, no trend, and no proof the CGM is streaming, so every surface
 * that names a source ("EN LÍNEA", "Precargada desde CGM", the provider
 * subtitle) has to check `isSensorReading` before claiming the value came
 * from the sensor.
 *
 * Use this for anything that presents "now"/"the current trend" — the
 * live-status badge, the correction calculator's auto-fill, and the trend
 * chart's highlighted latest point. A same-day CSV import can leave a
 * MySugr row young enough to pass `assessFreshness`, or to sort as the
 * chronologically-last point in a recent window, and any code that reads
 * the raw readings array directly (`.at(-1)`, `[length - 1]`, etc.)
 * without going through this risks showing imported history as if it
 * were live — exactly what AGENTS.md prohibits.
 */
export function liveReadings(readings: readonly CGMReading[]): CGMReading[] {
  return readings.filter((reading) => reading.origin !== 'imported');
}

/**
 * True only for readings that actually came off a sensor feed. Manual
 * entries are current (see `liveReadings`) but are not sensor data, and
 * synthetic ones are not real data at all — neither may be presented as
 * evidence that the CGM is connected and streaming.
 */
export function isSensorReading(reading: CGMReading): boolean {
  return reading.origin === 'real';
}

/**
 * The most recent reading that can legitimately stand in for "current
 * glucose". `readings` is expected sorted ascending by `sourceTimestamp`
 * (as `getCGMReadings` returns it) — see `liveReadings` for why imported
 * rows are excluded.
 */
export function latestLiveReading(readings: readonly CGMReading[]): CGMReading | null {
  const live = liveReadings(readings);
  return live.length === 0 ? null : live[live.length - 1]!;
}
