# ADR 0001: Local-first event storage

status: Accepted (2026-08-12)

Type 1A stores user-entered meals, carbohydrates, insulin events, therapy settings, cached CGM, and episode metrics on-device in SQLite. The backend protects external secrets and performs remote integrations; it is not required for manual logging.

Consequences:

- Quick Entry continues during network outages.
- Remote sync is deliberately outside version 0.1.
- Database migrations and at-rest protection are first-class engineering concerns.
