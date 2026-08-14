# CGM integration decision — 2026-08-12

## Decision

Use a provider abstraction and prioritize Junction's `freestyle_libre` practice-based LibreView connection in the EU region. Do not make LibreLinkUp reverse engineering a critical dependency.

## What changed since the master context v0.1

Junction's current documentation says its patient-login provider, `abbott_libreview`, is no longer available for new connections to organizations without an existing active connection. The supported new path is `freestyle_libre`, where the patient shares their LibreView account with a LibreView practice. Chile is listed under Junction's EU region.

For testing, Junction supports synthetic FreeStyle Libre data in sandbox. Demo users expire after seven days and provide normalized Summary data.

## Assessment of the three options visible in the FreeStyle app

| Option | Intended use | Runtime suitability | MVP decision |
|---|---|---:|---|
| LibreView | Historical/cloud data shared with a healthcare practice | High through an authorized integrator/practice, not as a public patient API | Primary via Junction `freestyle_libre` |
| LibreLinkUp | Near-real-time sharing with family/caregivers | Technically attractive, but no public general developer API was identified | Experimental feature flag only; not implemented as a hidden dependency |
| Libre Data Share | Temporary access code for a healthcare team; the current app explicitly describes limited-duration access | Low for continuous background sync | Excluded as runtime; useful only for temporary clinical review |

## Operational connection for the first tester

1. Create a Junction EU sandbox user and connect a FreeStyle demo provider.
2. Validate normalization, timestamps, data age, deduplication, and provider failures.
3. For real data, use a Junction EU production account.
4. In the FreeStyle app, open **Connected Apps → LibreView → Manage** and connect to the Junction-provided production practice (`tryVital`) or an approved custom practice.
5. Configure the backend with the Junction EU API key and user ID.
6. Confirm that the UI marks disconnections, delayed readings, and source attribution correctly before relying on it for episode analysis.

## Fallback ladder

1. Junction/LibreView practice connection.
2. Manual LibreView CSV import for historical data (not presented as live).
3. Manual glucose entry when no cloud data is available.
4. Consider a LibreLinkUp experimental adapter only after reviewing Abbott terms and accepting breakage risk for the private tester build.

## Non-decision

This decision does not claim Abbott approval of Type 1A, nor does it make Type 1A a primary glucose alarm system. FreeStyle remains the authoritative alarm surface.
