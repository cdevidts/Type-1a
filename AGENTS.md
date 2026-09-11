# Type 1A engineering rules

These rules apply to the entire repository.

## Safety boundaries

- Never let an LLM calculate, infer, or recommend insulin.
- Never infer therapy parameters. Target glucose, correction factor, and dose increment are user-entered values.
- Never silently use stale CGM values. Preserve `sourceTimestamp` separately from `ingestedAt`.
- Never present synthetic, mock, imported, or delayed CGM data as live sensor data.
- Insulin-on-board is allowed only under all of these, and never automatic
  dosing: a published, cited model (`packages/domain/src/iob.ts`); parameters
  the user entered; the subtraction shown in full on screen; subtracted from
  the correction half only, never from carb coverage; and no estimate at all
  when the user has not chosen an insulin — absence is never zero. See
  `docs/adr/0005-insulin-on-board.md`.
- AI-estimated carbohydrates remain separate from user-confirmed carbohydrates.
- A failed AI or CGM provider must degrade to manual logging.

## Privacy and secrets

- Never expose Abacus, Junction, signing, or other server secrets in mobile code.
- Do not log request bodies containing glucose, insulin, food, images, or therapy settings.
- Send the minimum necessary data to external AI services.
- Remove image metadata before remote analysis where the platform supports it.

## Architecture

- External CGM integrations implement `CGMProvider`.
- Sensitive calculations live in `packages/domain` and remain deterministic.
- Runtime AI integrations live behind the backend.
- Validate all external input and AI output with Zod.
- Prefer local-first storage for the user timeline.

## Completion

- Run `pnpm verify` before declaring work complete.
- Keep a manual fallback for each external dependency.
- Add tests for safety-sensitive behavior and provider normalization.
