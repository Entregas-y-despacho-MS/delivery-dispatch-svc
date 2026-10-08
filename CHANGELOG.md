# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `GET /pending-orders`: inbox of orders waiting to be planned (`pending` plus `rescheduled` for today) with zone, shift, priority and fuzzy search filters, sorting, `{ data, total, page, limit }` pagination, package weight and volume (ST-48.2, RF-A40).
- Soft reservation of orders while a coordinator plans a route: `POST /dispatch-reservations`, `/renew` and `/release`; expires on its own after `order_reservation_ttl_minutes` (ST-48.2).
- `DispatchStatusEnum` now lists every status of `dispatch_statuses`.

## [0.1.0] - 2026-10-06
First tagged milestone — end of Sprint 1. The API is still under active development; breaking
changes are expected before a 1.0.0 release.

### Added
- JWT authentication with refresh token rotation, role-based guards (`ROOT`/`ADMIN`/`COORDINATOR`/
  `SUPERVISOR`/`DRIVER`), optional TOTP 2FA, account lockout after repeated failed logins, a
  three-rule password policy (composition, expiration, reuse prevention), and email-based password
  reset.
- Business-configurable settings module, decoupled from `.env` (`settings` table, cached in memory).
- Users module: full CRUD, server-side pagination, dynamic filters and search.
- Roles module: assign/manage operator roles and permissions, with per-role user counts (RF-A27).
- Vehicle fleet module: CRUD with unique plate validation and load/volume capacity checks (RF-A30).
- Delivery zones module: CRUD with unique code validation (RF-A29).
- Service levels catalog: priority hierarchy and target delivery time / SLA in minutes (RF-A31).
- Incident reasons catalog for delivery exceptions (RF-A32).
- Reschedule/reassignment reasons catalog (RF-A33).
- Vehicle mechanical incident types catalog, with an automatic maintenance-status trigger on the
  related vehicle (RF-A34).
- Real-time GPS telemetry ingestion (WebSocket + REST) with live dispatch-board broadcast (RF-U11).
- Offline-first sync endpoints with idempotency-key handling for batched mobile sync (RF-U13).
- Driver logout endpoint that tears down active tracking sessions (RF-U08).
- Mailer, WebSockets (Socket.io) and PDF generation (Puppeteer) plugins, all Port & Adapter.
- Full Swagger/OpenAPI documentation for every endpoint, DTO and error response.
- `Dockerfile` and `docker-compose.yml` for the full stack (API + database + OSRM routing).

### Fixed
- `reschedule_reasons` catalog was missing `code` and the derived `affectsSla` field.
- `password_changed_at` had no explicit default.
- Sending `null` on vehicle, user or delivery-zone updates returned 500 instead of a 400.
- An empty `active` query filter was treated as `IS NULL` instead of "no filter" (users, service
  levels, vehicles).
- A non-numeric `roleId` caused a 500; search filters did not escape SQL wildcards.
- Swagger's "Try it out" pre-filled placeholder example values and showed inaccurate error examples.

### Security
- Closed 12 issues found in a full backend security/robustness review.
- The access token is re-verified against the current state of the user on every request (role,
  active flag and password-change requirement are read live, not trusted from the token payload).
- Refresh tokens are stored as SHA-256 hashes (not bcrypt, which silently truncates at 72 bytes);
  each token carries a unique `jti`, and reuse of an already-rotated token revokes every session.
- Failed login attempts are counted with a single atomic update, closing a race that let parallel
  attempts bypass the lockout threshold.
- Root accounts cannot be deleted, deactivated or re-roled by an admin; no account can perform
  those actions on itself.
