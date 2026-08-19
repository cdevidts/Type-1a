/**
 * Standard hypoglycemia cutoff (mg/dL).
 *
 * This is NOT a therapy parameter the user configures — it is the widely
 * used clinical threshold for "this is a low". It is used only to decide
 * whether to warn, and never to alter a calculated dose.
 *
 * It lives here, in `packages/domain`, so the screens that show the warning
 * can't each keep their own copy and drift apart.
 */
export const HYPOGLYCEMIA_THRESHOLD = 70;

export function isHypoglycemic(glucose: number): boolean {
  return glucose < HYPOGLYCEMIA_THRESHOLD;
}

/**
 * Standard ATTD/ADA consensus band edges for Time in Range reporting
 * (Battelino et al., Diabetes Care 2019), all in mg/dL. Like
 * `HYPOGLYCEMIA_THRESHOLD` above, these are fixed clinical conventions used
 * only to describe already-measured glucose — never therapy parameters, and
 * never used to calculate or adjust a dose.
 */
export const VERY_LOW_THRESHOLD = 54;
export const HIGH_THRESHOLD = 180;
export const VERY_HIGH_THRESHOLD = 250;
