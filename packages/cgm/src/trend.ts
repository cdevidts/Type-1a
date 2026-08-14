import type { CGMReading, CGMTrend } from '@type1a/schemas';

export function trendFromRate(rateMgDlPerMinute: number): CGMTrend {
  if (!Number.isFinite(rateMgDlPerMinute)) return 'unknown';
  if (rateMgDlPerMinute <= -3) return 'rapid_down';
  if (rateMgDlPerMinute <= -2) return 'down';
  if (rateMgDlPerMinute <= -1) return 'slight_down';
  if (rateMgDlPerMinute < 1) return 'stable';
  if (rateMgDlPerMinute < 2) return 'slight_up';
  if (rateMgDlPerMinute < 3) return 'up';
  return 'rapid_up';
}

export function addDerivedTrends(readings: readonly CGMReading[]): CGMReading[] {
  const sorted = [...readings].sort(
    (a, b) => Date.parse(a.sourceTimestamp) - Date.parse(b.sourceTimestamp),
  );

  return sorted.map((reading, index) => {
    const prior = sorted[index - 1];
    if (prior === undefined) return reading;
    const minutes = (Date.parse(reading.sourceTimestamp) - Date.parse(prior.sourceTimestamp)) / 60_000;
    if (minutes <= 0) return reading;
    return {
      ...reading,
      trend: trendFromRate((reading.glucose - prior.glucose) / minutes),
      trendSource: 'derived',
    };
  });
}
