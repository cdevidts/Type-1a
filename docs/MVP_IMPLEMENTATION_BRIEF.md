# Type 1A — MVP implementation brief

## Outcome

Deliver a private Android-first MVP for one adult tester with type 1 diabetes. The product must reduce manual reconstruction by joining food, confirmed carbohydrates, insulin events, CGM readings, and post-meal metrics.

## Critical path

1. The user can log rapid insulin, basal insulin, or carbohydrates in seconds.
2. The event persists locally and appears in a unified timeline.
3. CGM data is normalized through `CGMProvider`, with real source time and freshness visible.
4. A meal can be photographed, analyzed by Abacus RouteLLM, corrected, and confirmed.
5. The system builds a Meal Episode and computes +60/+120/+180, peak, delta, and time-to-peak deterministically.
6. AI may explain those metrics descriptively but may not recommend therapy.

## Safety acceptance criteria

- No negative insulin or carbohydrates.
- Correction factor and dose increment must be positive.
- A stale CGM value is not silently used as current.
- Recent rapid insulin is shown, but no insulin-on-board is estimated.
- Synthetic data is visibly labelled.
- AI carbohydrates are never silently confirmed.
- AI output that contains dose-changing advice is rejected.
- No provider or model secret enters the mobile bundle.

## FreeStyle strategy

> **⚠️ 2026-08-21 update: this section is the original decision (2026-08-12),
> NOT what runs today.** The real production path is **LibreLinkUp**,
> connected per-installation from the user's own phone — not Junction, and
> the "LibreLinkUp experimental provider only after..." contingency below is
> stale. Full story: [`CGM_INTEGRATION_DECISION.md`](CGM_INTEGRATION_DECISION.md).
> Current user guide: [`CONECTAR_SENSOR.md`](CONECTAR_SENSOR.md). The rest of
> this brief stands as the historical record of the v0.1 delivery.

Primary production path: Junction `freestyle_libre` through a LibreView practice in the EU region (Chile is supported).

Development path: deterministic mock plus Junction sandbox synthetic FreeStyle data.

Contingencies:

- LibreView CSV import for historical validation and episode backfill;
- LibreLinkUp experimental provider only after an explicit legal/technical decision;
- Libre Data Share is not a runtime integration because access is temporary and healthcare-team oriented.

## Definition of done for version 0.1

- installable Android build configuration;
- iOS-compatible React Native source;
- local SQLite storage;
- current glucose, trend, source time, age, and 3-hour graph;
- Quick Entry for carbs, rapid, basal, and correction;
- meal image analysis plus manual fallback and confirmation;
- timeline and episode metrics;
- local notifications;
- automated domain, safety, API, and provider tests;
- real-provider connection instructions and explicit known limitations.
