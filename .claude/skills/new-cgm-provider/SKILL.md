---
name: new-cgm-provider
description: Scaffold a new CGM data source in packages/cgm following the CGMProvider interface, with a matching test and the doc updates that decision requires. Use when the user asks to add support for a new glucose data source/provider (e.g. a new CGM vendor, a new import format, a new sandbox mode).
---

Scaffold a new `CGMProvider` implementation for Type 1A.

1. Read `packages/cgm/src/provider.ts` — the `CGMProvider` interface
   (`getLatestReading`, `getReadings`, `getStatus`) and `CGMProviderError`. Every
   provider must implement this interface exactly; don't invent a parallel shape.

2. Look at `packages/cgm/src/mock.ts` and `packages/cgm/src/junction.ts` as
   reference implementations — one synthetic, one real-integration — for the
   level of error handling and normalization expected (timestamps, trend
   normalization via `trend.ts`, distinguishing `sourceTimestamp` from
   `ingestedAt`).

3. Create `packages/cgm/src/<provider-name>.ts` implementing `CGMProvider`.
   Non-negotiable, per `AGENTS.md`:
   - Preserve `sourceTimestamp` separately from `ingestedAt` — never collapse them.
   - If this provider is synthetic, mock, imported, or delayed in any way, it
     must be visibly labelled as such wherever it surfaces (never presented as
     live sensor data).
   - On failure, it must be possible for the caller to degrade to manual
     logging — don't throw in a way that crashes the app; use
     `CGMProviderError` with an appropriate `code`.

4. Create `packages/cgm/test/<provider-name>.test.ts` mirroring the existing
   test files in that directory — cover normal reading, stale/missing data, and
   at least one provider-error path.

5. If the new provider talks to an external service, wire its config through
   `apps/api/src/config.ts` (`EnvironmentSchema`) the same way `JUNCTION_*` is
   wired — never read `process.env` directly elsewhere, and never let its
   credentials reach `apps/mobile`.

6. Update docs in the same change:
   - `docs/CODE_MAP.md` — add the new file under "packages/cgm — proveedores de
     glucosa".
   - `docs/CGM_INTEGRATION_DECISION.md` — add a row/section explaining why this
     provider was added and where it sits in the fallback ladder, following the
     existing table format.

7. Run `pnpm --filter @type1a/cgm typecheck && pnpm --filter @type1a/cgm test`
   (or the `/verify` skill for the full suite) before considering this done.

8. If the provider touches anything that could look like therapy-relevant data
   quality (e.g. how staleness or disconnection is surfaced), flag it for the
   **domain-safety-reviewer** subagent.
