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
