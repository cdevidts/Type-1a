---
name: verify
description: Run Type 1A's full verification suite (lint + typecheck + test across all pnpm packages) and report a concise pass/fail summary per package instead of dumping the raw log. Use before considering any change to this repo complete, and whenever the user asks to "verify", "run tests", "check lint", or "check typecheck".
---

Run the repo's verify pipeline and summarize the result.

1. From the repo root, run:
   ```bash
   pnpm verify
   ```
   This runs `pnpm lint && pnpm typecheck && pnpm test` across every package in
   the pnpm workspace (`apps/api`, `apps/mobile`, `packages/domain`,
   `packages/cgm`, `packages/ai`, `packages/schemas`).

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
