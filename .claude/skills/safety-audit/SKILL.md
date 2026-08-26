---
name: safety-audit
description: Audit the current diff (uncommitted changes, or a range/PR the user names) against Type 1A's AGENTS.md safety boundaries before calling a change finished. Use whenever the user asks to "check safety", "audit this change", or before wrapping up work that touched insulin, glucose, dosing, or AI-facing code.
---

Audit pending changes against `AGENTS.md` before they're considered done.

1. Determine the diff to review: `git diff` for unstaged changes, `git diff
   --staged` for staged ones, or whatever range/PR the user named. If both
   staged and unstaged have content, review both and say so.

2. Delegate the actual review to the **domain-safety-reviewer** subagent
   (`.claude/agents/domain-safety-reviewer.md`), passing it the diff or the list
   of changed files. That agent is read-only and checks specifically against
   `AGENTS.md` and `contracts/safety-acceptance.md` — those two files are the
   whole checklist, and neither is optional.

3. If the diff doesn't touch `packages/domain`, `packages/ai`, `packages/cgm`,
   `apps/api/src/config.ts`, or `.env`-related files, say so and skip the
   subagent call — don't spend a review cycle on changes with no safety surface
   (e.g. a UI copy change in `apps/mobile/src/theme.ts`).

4. Present the subagent's findings as-is to the user. Do not silently fix them
   yourself unless the user asks you to — safety findings in this repo should be
   seen and acknowledged, not auto-patched away.
