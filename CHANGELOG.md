# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-09
Combined delivery for Sprint 2 and Sprint 3 — `main`/`test` were not updated at the end of Sprint 2,
so this release ships both at once. Still pre-1.0; breaking changes are expected.

### Added
- **Dispatch planning and route batches**: unassigned-orders inbox with soft reservation (ST-48.2),
  dispatch generation from consolidated orders (ST-49.1, ST-49.4), weight/volume capacity validation
  against real package data (ST-50.1), the provisional lot planner with an OSRM time matrix, 2h
  slots and late-order insertion (ST-50.2), the scheduler/distributed-lock/manual-trigger
  infrastructure behind it (ST-50.3), load-balanced reviewer assignment with automatic reassignment
  on an inactive reviewer (ST-50.4), lost-message recovery and incomplete-order alerts (ST-50.5),
  manual dispatch priority (ST-58.2), and pickups folded into the lot generator and both approvals
  (ST-81.3).
- **Final review and promise lifecycle**: 1st (promise) and 2nd (final) batch approvals with
  concurrency control (ST-215.2, ST-51.2), simulated promise/reminder/risk emails (ST-215.3), the
  12h firmness window and prep-order task (ST-215.4), batch query for review (ST-215.5), the D-1
  cutoff with reoptimization and final-batch validation (ST-51.3), reminder/escalation alerts for a
  late 2nd approval (ST-51.4), driver/vehicle correction on a batch with revalidation (ST-51.6), a
  new promise signature after a dispatch is rescheduled (ST-241.2), and the coordinator's
  reschedule with a non-completed-delivery cap and audit trail (ST-52.2).
- **In-execution batch operations**: a single state-change entry point with audit and real-time
  events (`PATCH /dispatches/:id/status`, ST-30.3), automatic batch closing (ST-30.4), "Start the
  Day's Route" (ST-51.5), accepting a batch and recording cargo-check mismatches (ST-210.1),
  reassigning stops between in-execution batches (ST-63.1), and live socket sync to the dashboard
  (ST-53.2).
- **Driver mobile endpoints**: delivery-of-record evidence with multipart storage and a
  cryptographic OTP validator (ST-31.3), OTP generation/simulated SMS/expiry (ST-31.4), retiring the
  old `/sync/events` and `/sync/evidences` (ST-31.6), incident reporting with a real-time
  operational alert (ST-32.2), paginated driver history (ST-33.2), driver performance metrics with a
  Redis cache (ST-35.2), the push-notification sender service (ST-36.2), push-token persistence and
  register/revoke endpoints (ST-36.3), and a completed `GET /dispatches/my-assignments` contract
  (ST-49.5).
- **Public customer tracking**: token-based public tracking and reschedule endpoints, including
  slot offers, change requests and an IP rate limit (ST-224.1), live ETA via OSRM with caching
  (ST-40.1), a rating left from the tracking link (ST-42.1), and a comment on the rating shown on the
  360° record (ST-43.1).
- **Reporting and supervision**: SLA compliance report with aggregations and a Redis cache
  (ST-54.2), paginated dispatch history with CSV export (ST-55.2), the dispatch's 360° record with
  timeline and evidence (ST-56.2), the Supervisor permission matrix (ST-59.1), fleet KPIs over the
  SLA report (ST-61.1), vehicle status change with a reason (ST-62.1), maintenance history/tracking/
  closing (ST-64.1), fleet report by period (ST-65.1), live fleet positions (ST-60.1), a real-time
  alert evaluator (ST-66.2), and configurable alert thresholds in settings (ST-67.1).
- **ERP interoperability and reverse logistics**: the simulated async messaging infrastructure —
  Pub/Sub adapter, in-memory adapter, outbox with retries, envelope/schema validation (ST-72.0) —
  the Marketplace delivery-data consumer merged by sales order (ST-72.2), the shared consumer base
  (ST-72.4), warehouse package-change consumption on existing dispatches (ST-72.5), outbox-backed
  publication of the physical departure and of delivery results (`dispatch.transfer.status_changed`,
  ST-73.1, ST-73.3), automated contract verification (ST-73.4), the ERP simulator for Marketplace/
  Warehouse/Procurement (ST-73.2), the supplier-pickup consumer (ST-74.1), the supplier pickup
  scheduling service (ST-75.1), Procurement↔Despachos integration tests (ST-75.2), the consolidated
  JSON Schema catalog for every topic (ST-76.1), home pickup and warehouse-arrival registration
  (ST-80.2), manual pickup-order creation/cancellation/listing (ST-81.2), the `inventory.return.
  requested` consumer for RMAs (ST-238.2), its simulator and contract verification (ST-238.3),
  supplier-pickup and warehouse-arrival registration (ST-239.2), the `inventory.receipt.confirmed`
  consumer (ST-240.2), transfer-result publication (ST-240.3), its simulator and end-to-end tests
  (ST-240.4), reading the receipt on the record and on Pickups (ST-240.6), extending the
  coordinator's cancellation to pre-route statuses (ST-241.1), and listing/resolving dispatches
  excluded by a cargo-check mismatch (ST-241.3).
- **Deploy readiness**: a production-grade multi-stage Docker image with a non-root user and
  `/health` healthcheck (ST-242.1), and the supporting database/Redis/Pub-Sub/migrations
  infrastructure groundwork (ST-242.2).

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
