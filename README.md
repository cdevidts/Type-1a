# Type 1A

Type 1A is an Android-first, local-first diabetes type 1 companion MVP. It connects glucose, meals, confirmed carbohydrates, insulin logging, and descriptive post-meal analysis while keeping dosing decisions outside AI.

> Development software only. It does not replace FreeStyle Libre alarms, blood glucose confirmation when indicated, or professional medical advice.

## What works in this repository

- deterministic correction math using user-entered therapy parameters;
- explicit recent-insulin context without insulin-on-board estimation;
- local SQLite timeline for rapid insulin, basal insulin, carbohydrates, meals, and cached CGM;
- clearly labelled synthetic CGM provider for development;
- Junction/LibreView EU connector behind the backend;
- Abacus.AI RouteLLM meal vision and descriptive episode insight services;
- offline manual logging and manual meal fallback;
- deep-link-ready Quick Entry routes;
- local episode notifications and safety tests;
- explicit insulin-to-meal confirmation whenever the association is ambiguous.

## Start locally

Requirements: Node 24+, pnpm 11+, and an Android phone/emulator for the mobile client.

```bash
cp .env.example .env
cp apps/mobile/.env.example apps/mobile/.env.local
pnpm install
pnpm verify
pnpm dev:api
pnpm dev:mobile
```

For a physical phone, set `EXPO_PUBLIC_API_BASE_URL` to the backend's LAN URL, for example `http://192.168.1.20:4100`.

## External integrations

The backend remains functional without external credentials:

- no Junction key: it uses a visibly labelled synthetic provider;
- no Abacus key: meal analysis falls back to manual entry;
- no internet: Quick Entry and the local timeline continue working.

See [docs/CGM_INTEGRATION_DECISION.md](docs/CGM_INTEGRATION_DECISION.md) before enabling real FreeStyle data.

Implementation references are recorded in [docs/RESEARCH_SOURCES.md](docs/RESEARCH_SOURCES.md).

## Builds

`apps/mobile/eas.json` defines an internal Android APK profile (the Expo project root is `apps/mobile`, not the repo root — EAS resolves config relative to it). A signed binary requires an Expo account.

**Signing credentials are local, not EAS-managed** (`credentialsSource: "local"` in `eas.json`, `apps/mobile/credentials.json` + `apps/mobile/credentials/android/keystore.jks` — both gitignored, absent from this repository on purpose). This is deliberate: the app has real installs in the field, and Android refuses to install an update signed with a different key than what's already on the device — using the same keystore regardless of which EAS account/project builds it is what keeps future builds installable as updates instead of forcing a reinstall (data loss, since the app is local-first with no cloud backup). See `docs/ROADMAP_V0.2.md` § "Migración de cuenta EAS" for the full story, the exact keystore fingerprint, and — critically — what never to do with `eas credentials` on this project.
