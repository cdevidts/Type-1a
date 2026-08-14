import type { CGMState } from '@type1a/schemas';

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
