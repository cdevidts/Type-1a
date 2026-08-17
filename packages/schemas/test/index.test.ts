import { describe, expect, it } from 'vitest';

import {
  ActivityEventSchema,
  CarbEventSchema,
  HbA1cLabResultSchema,
  InsulinEventSchema,
  MealEventSchema,
  TherapyProfileSchema,
  VitalsEventSchema,
} from '../src/index.js';

const BASE_PROFILE = {
  glucoseUnit: 'mg/dL' as const,
  targetGlucose: 110,
  correctionFactor: 45,
  doseIncrement: 0.5,
};

describe('TherapyProfileSchema', () => {
  it('stays valid without carbRatio (existing profiles predate this field)', () => {
    expect(TherapyProfileSchema.safeParse(BASE_PROFILE).success).toBe(true);
  });

  it('accepts a positive carbRatio', () => {
    expect(TherapyProfileSchema.safeParse({ ...BASE_PROFILE, carbRatio: 12 }).success).toBe(true);
  });

  it('rejects a zero or negative carbRatio', () => {
    expect(TherapyProfileSchema.safeParse({ ...BASE_PROFILE, carbRatio: 0 }).success).toBe(false);
    expect(TherapyProfileSchema.safeParse({ ...BASE_PROFILE, carbRatio: -5 }).success).toBe(false);
  });
});

describe('CarbEventSchema', () => {
  it('accepts imported as a source, alongside the existing manual/meal_confirmed', () => {
    const base = { id: 'c1', timestamp: '2026-08-14T12:00:00.000Z', carbsG: 40, createdAt: '2026-08-14T12:00:00.000Z' };
    expect(CarbEventSchema.safeParse({ ...base, source: 'imported' }).success).toBe(true);
    expect(CarbEventSchema.safeParse({ ...base, source: 'manual' }).success).toBe(true);
    expect(CarbEventSchema.safeParse({ ...base, source: 'meal_confirmed' }).success).toBe(true);
    expect(CarbEventSchema.safeParse({ ...base, source: 'bogus' }).success).toBe(false);
  });
});

describe('InsulinEventSchema', () => {
  it('accepts an optional purpose without requiring it', () => {
    const base = {
      id: 'i1',
      timestamp: '2026-08-14T12:00:00.000Z',
      type: 'rapid' as const,
      units: 4,
      source: 'imported' as const,
      createdAt: '2026-08-14T12:00:00.000Z',
    };
    expect(InsulinEventSchema.safeParse(base).success).toBe(true);
    expect(InsulinEventSchema.safeParse({ ...base, purpose: 'correction' }).success).toBe(true);
    expect(InsulinEventSchema.safeParse({ ...base, purpose: 'bogus' }).success).toBe(false);
  });
});

describe('MealEventSchema', () => {
  it('accepts an optional free-text note', () => {
    const base = { id: 'm1', timestamp: '2026-08-14T12:00:00.000Z', createdAt: '2026-08-14T12:00:00.000Z' };
    expect(MealEventSchema.safeParse(base).success).toBe(true);
    expect(MealEventSchema.safeParse({ ...base, note: 'Pizza con los decadentes' }).success).toBe(true);
    expect(MealEventSchema.safeParse({ ...base, note: 'x'.repeat(301) }).success).toBe(false);
  });
});

describe('ActivityEventSchema', () => {
  it('accepts the MySugr 1-3 intensity scale and rejects anything outside it', () => {
    const base = { id: 'a1', timestamp: '2026-08-14T12:00:00.000Z', source: 'imported' as const, createdAt: '2026-08-14T12:00:00.000Z' };
    expect(ActivityEventSchema.safeParse({ ...base, intensity: 1 }).success).toBe(true);
    expect(ActivityEventSchema.safeParse({ ...base, intensity: 3 }).success).toBe(true);
    expect(ActivityEventSchema.safeParse({ ...base, intensity: 4 }).success).toBe(false);
  });
});

describe('VitalsEventSchema', () => {
  const base = { id: 'v1', timestamp: '2026-08-14T12:00:00.000Z', source: 'imported' as const, createdAt: '2026-08-14T12:00:00.000Z' };

  it('rejects an entry with no measurement at all', () => {
    expect(VitalsEventSchema.safeParse(base).success).toBe(false);
  });

  it('accepts an entry with just one measurement', () => {
    expect(VitalsEventSchema.safeParse({ ...base, weightKg: 70 }).success).toBe(true);
    expect(VitalsEventSchema.safeParse({ ...base, ketonesMmolL: 0.3 }).success).toBe(true);
  });
});

describe('HbA1cLabResultSchema', () => {
  it('accepts a realistic lab percentage and rejects a non-positive one', () => {
    const base = { id: 'h1', timestamp: '2026-08-14T12:00:00.000Z', source: 'manual' as const, createdAt: '2026-08-14T12:00:00.000Z' };
    expect(HbA1cLabResultSchema.safeParse({ ...base, percentage: 7.2 }).success).toBe(true);
    expect(HbA1cLabResultSchema.safeParse({ ...base, percentage: 0 }).success).toBe(false);
  });
});
