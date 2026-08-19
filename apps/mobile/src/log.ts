/**
 * Every save path in this app swallows its errors with a bare `catch {}` and
 * shows a generic "no se pudo guardar" message — safe for the user, but it
 * means a real failure (a schema rejection, a native SQLite error, a
 * scheduling call throwing) leaves no trace anywhere. This is the one place
 * that logs it, so the actual cause shows up in the Metro/Expo dev console
 * (or `adb logcat` for a built APK) instead of vanishing.
 *
 * Deliberately logs only `error.name`/`error.message`, never the error object
 * itself or any of the data being saved — AGENTS.md forbids logging request
 * bodies containing glucose, insulin, food, or therapy settings, and a raw
 * object dump (e.g. a ZodError's `issues`) could carry the value that failed
 * validation.
 */
export function logSaveError(context: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[type1a] ${context} failed — ${detail}`);
}
