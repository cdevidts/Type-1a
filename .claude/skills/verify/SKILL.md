---
name: verify
description: Run Type 1A's full verification suite (lint + typecheck + test across all pnpm packages) and report a concise pass/fail summary per package instead of dumping the raw log. Use before considering any change to this repo complete, and whenever the user asks to "verify", "run tests", "check lint", or "check typecheck".
---

Run the repo's verify pipeline and summarize the result.

1. From the repo root, run:
   ```bash
   pnpm verify
   ```
   This runs, in order:
   - `verify:contracts` — the agentic-memory guard (every path declared in
     `contracts/manifest.json` exists, nothing under `.claude/` references a
     document that isn't declared, and no layer blows its line budget). It runs
     first because it takes under a second and catches a broken skill input
     before the slow steps spend three minutes.
   - `lint`, `typecheck`, `test` across every package in the pnpm workspace
     (`apps/api`, `apps/mobile`, `packages/domain`, `packages/cgm`,
     `packages/ai`, `packages/schemas`).
   - `verify:bundle` — a real `expo export` for Android. This is the only step
     that catches a Metro-only break (a relative import written with `.js`,
     which `tsc` and `vitest` both resolve and Metro does not).

2. If `pnpm install` hasn't been run yet in this environment (missing
   `node_modules`), run `pnpm install` first.

3. Report results as a short per-package table: package name, lint/typecheck/test
   status. For any failure, quote only the relevant error lines (file, line,
   message) — not the full stdout.

4. If a failure touches `packages/domain` or `packages/ai`, mention that the
   **domain-safety-reviewer** subagent should review the change before it's
   considered done, since those packages carry safety-critical logic.

5. Do not attempt to silence a failing check by weakening it (loosening a type,
   deleting a test, disabling a lint rule) unless the user explicitly asks for
   that — report the failure and let the user decide.

6. `verify:contracts` is the one step with a legitimate self-repair: if it fails
   because a reference moved, run `node scripts/agentic-contracts.mjs scan` to
   regenerate the manifest and **read the diff before committing it**. If it
   fails because a declared document no longer exists, that's a skill left
   without its input — fix the reference, never delete the declaration.
