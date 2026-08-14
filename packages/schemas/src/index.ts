import { z } from 'zod';

export const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const GlucoseUnitSchema = z.enum(['mg/dL', 'mmol/L']);
export type GlucoseUnit = z.infer<typeof GlucoseUnitSchema>;

export const CGMTrendSchema = z.enum([
  'rapid_down',
  'down',
  'slight_down',
  'stable',
  'slight_up',
  'up',
  'rapid_up',
  'unknown',
]);
export type CGMTrend = z.infer<typeof CGMTrendSchema>;

export const CGMReadingSchema = z.object({
  id: z.string().min(1),
  glucose: z.number().positive().finite(),
  unit: GlucoseUnitSchema,
  timestamp: IsoTimestampSchema,
  trend: CGMTrendSchema,
  trendSource: z.enum(['provider', 'derived', 'unknown']),
  source: z.string().min(1),
  origin: z.enum(['real', 'synthetic', 'imported', 'manual']),
  sourceTimestamp: IsoTimestampSchema,
  ingestedAt: IsoTimestampSchema,
});
export type CGMReading = z.infer<typeof CGMReadingSchema>;

export const CGMStateSchema = z.enum([
  'connected',
  'stale',
  'offline',
  'provider_error',
  'authentication_required',
  'not_connected',
]);
export type CGMState = z.infer<typeof CGMStateSchema>;

export const CGMProviderStatusSchema = z.object({
  state: CGMStateSchema,
  provider: z.string().min(1),
  detail: z.string().optional(),
  lastSourceTimestamp: IsoTimestampSchema.optional(),
  checkedAt: IsoTimestampSchema,
  isSynthetic: z.boolean(),
});
export type CGMProviderStatus = z.infer<typeof CGMProviderStatusSchema>;

export const TherapyProfileSchema = z.object({
  glucoseUnit: GlucoseUnitSchema,
  targetGlucose: z.number().positive().finite(),
  correctionFactor: z.number().positive().finite(),
  doseIncrement: z.number().positive().max(1).finite(),
  rapidInsulinName: z.string().trim().max(80).optional(),
  basalInsulinName: z.string().trim().max(80).optional(),
});
export type TherapyProfile = z.infer<typeof TherapyProfileSchema>;

export const InsulinEventSchema = z.object({
  id: z.string().min(1),
  timestamp: IsoTimestampSchema,
  type: z.enum(['rapid', 'basal']),
  units: z.number().positive().max(100).finite(),
  insulinName: z.string().trim().max(80).optional(),
  source: z.enum(['manual', 'imported']),
  createdAt: IsoTimestampSchema,
});
export type InsulinEvent = z.infer<typeof InsulinEventSchema>;

export const CarbEventSchema = z.object({
  id: z.string().min(1),
  timestamp: IsoTimestampSchema,
  carbsG: z.number().nonnegative().max(500).finite(),
  source: z.enum(['manual', 'meal_confirmed']),
  createdAt: IsoTimestampSchema,
});
export type CarbEvent = z.infer<typeof CarbEventSchema>;

export const FoodEstimateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  estimatedGrams: z.number().nonnegative().max(3000).finite().nullable(),
  carbsG: z.number().nonnegative().max(500).finite(),
  proteinG: z.number().nonnegative().max(500).finite(),
  fatG: z.number().nonnegative().max(500).finite(),
  fiberG: z.number().nonnegative().max(200).finite(),
  caloriesKcal: z.number().nonnegative().max(10000).finite(),
  confidence: z.number().min(0).max(1).finite(),
});
export type FoodEstimate = z.infer<typeof FoodEstimateSchema>;

export const MealAnalysisSchema = z.object({
  foods: z.array(FoodEstimateSchema).min(1).max(30),
  uncertaintyNotes: z.array(z.string().trim().min(1).max(300)).max(12),
});
export type MealAnalysis = z.infer<typeof MealAnalysisSchema>;

export const MealTotalsSchema = z.object({
  carbsG: z.number().nonnegative().finite(),
  proteinG: z.number().nonnegative().finite(),
  fatG: z.number().nonnegative().finite(),
  fiberG: z.number().nonnegative().finite(),
  caloriesKcal: z.number().nonnegative().finite(),
});
export type MealTotals = z.infer<typeof MealTotalsSchema>;

export const MealAnalysisResultSchema = z.object({
  analysisId: z.string().min(1),
  model: z.string().min(1),
  estimate: MealAnalysisSchema,
  totals: MealTotalsSchema,
});
export type MealAnalysisResult = z.infer<typeof MealAnalysisResultSchema>;

export const MealEventSchema = z.object({
  id: z.string().min(1),
  timestamp: IsoTimestampSchema,
  imageUri: z.string().min(1).optional(),
  aiEstimatedCarbsG: z.number().nonnegative().max(500).finite().optional(),
  confirmedCarbsG: z.number().nonnegative().max(500).finite().optional(),
  proteinG: z.number().nonnegative().max(500).finite().optional(),
  fatG: z.number().nonnegative().max(500).finite().optional(),
  fiberG: z.number().nonnegative().max(200).finite().optional(),
  caloriesKcal: z.number().nonnegative().max(10000).finite().optional(),
  aiAnalysisId: z.string().min(1).optional(),
  createdAt: IsoTimestampSchema,
});
export type MealEvent = z.infer<typeof MealEventSchema>;

export const MealEpisodeMetricsSchema = z.object({
  mealTimestamp: IsoTimestampSchema,
  startingGlucose: z.number().positive().finite().optional(),
  glucose60: z.number().positive().finite().optional(),
  glucose120: z.number().positive().finite().optional(),
  glucose180: z.number().positive().finite().optional(),
  peakGlucose: z.number().positive().finite().optional(),
  peakDelta: z.number().finite().optional(),
  timeToPeakMinutes: z.number().nonnegative().finite().optional(),
  minGlucose: z.number().positive().finite().optional(),
  timeAboveRangeMinutes: z.number().nonnegative().finite(),
  timeBelowRangeMinutes: z.number().nonnegative().finite(),
  rapidInsulinUnits: z.number().positive().finite().optional(),
  rapidInsulinTimestamp: IsoTimestampSchema.optional(),
  confirmedCarbsG: z.number().nonnegative().finite().optional(),
  proteinG: z.number().nonnegative().finite().optional(),
  fatG: z.number().nonnegative().finite().optional(),
  insulinToMealMinutes: z.number().finite().optional(),
  readingCount: z.number().int().nonnegative(),
});
export type MealEpisodeMetrics = z.infer<typeof MealEpisodeMetricsSchema>;

export const GlucoseInsightSchema = z.object({
  summary: z.string().trim().min(1).max(700),
  observations: z.array(z.string().trim().min(1).max(300)).max(5),
  limitations: z.array(z.string().trim().min(1).max(300)).max(5),
});
export type GlucoseInsight = z.infer<typeof GlucoseInsightSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const mealAnalysisJsonSchema = z.toJSONSchema(MealAnalysisSchema, {
  target: 'draft-2020-12',
});

export const glucoseInsightJsonSchema = z.toJSONSchema(GlucoseInsightSchema, {
  target: 'draft-2020-12',
});
