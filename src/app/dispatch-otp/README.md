# Delivery OTP — ST-31.4

`DispatchOtpModule` consumes the post-commit `dispatch.status_changed` event and rereads the dispatch.
Only `in_transit` + `high_value_control` issues a code. The source system guarantees verification of
`contact_phone` (user decision, 2026-10-18); absence or unusable format records
`dispatch_events.otp_resolution_required` for Dispatch intervention and preserves the evidence policy.
Numbers must contain 7–15 international digits, optionally preceded by `+`.

Settings `otp_code_length` (default 6, supported 4–10) and `otp_expiry_minutes` (default 60,
supported 1–1440) control generation and Redis TTL. Invalid values use the defaults. Digits use
`node:crypto.randomInt`, hashes use bcrypt with random salt. Only the hash is stored. The clear
code exists transiently while constructing the SMS and is never returned through HTTP, persisted
or logged. `SmsSender` is the replaceable transport port; its simulated implementation records a
structured `sms.sent` event with redacted content and no recipient. Replace the adapter for real SMS.

Redis uses existing `REDIS_HOST`/`REDIS_PORT`, dependency and configuration. A dedicated adapter is
necessary because the generic `CacheService` cannot express multi-key atomic OTP transitions.
Keys `dispatch-otp:{ID}:code` and `dispatch-otp:{ID}:limits` share a cluster slot. Lua serializes issue,
resend, failure increments, lockout and consumption. The code key expires; the limits hash stores
`failures`, `resends`, `consumed` and deliberately has no TTL, so expiry cannot bypass limits.
Duplicate initial events never replace an issued code, including after expiry. A controlled resend
replaces the hash, restarts TTL, preserves failures and is allowed at most twice. Three incorrect
verdicts burn the code. Successful verification consumes it exactly once. A compare against a
replaced generation returns `replaced` without consuming or incrementing attempts.

`POST /dispatches/:id/otp/resend` requires DRIVER (existing ROOT bypass still checks assignment),
current assignment and applicable policy/status. It returns only acceptance and expiry. Redis down
fails closed with 503. SMS failure conditionally invalidates that generation, retains the counters
and permits only a bounded controlled resend; it cannot restore an earlier code. Initial Redis
failure leaves no code; the resend endpoint can retry initial issuance after Redis recovery.
A process crash between Redis issue and simulated send can require a controlled resend. A database failure after SMS acceptance can return an error while the sent code remains active;
the listener attempts an operational resolution mark. Redis/SMS/PostgreSQL are not one transaction. Local
EventEmitter is not durable; no delivery guarantee or transactional outbox is introduced here.
Concurrent resends can deliver messages out of order, but only the latest Redis generation can verify.

`DispatchOtpService.verify` is an internal seam for ST-31.3. It does not register evidence or expose
an endpoint. Its consumer must enforce current policy/status/ownership and only record successful
OTP evidence. Hash comparison happens outside Redis; the atomic final verdict compares the observed
hash again, rejecting stale comparisons and concurrent reuse. No plaintext goes into Lua arguments.

Operational cleanup: retain the limits keys for as long as a dispatch could be reopened or replayed.
An explicit, separately designed archival job may delete both keys only when the dispatch is
permanently archived. There is no timer or automatic reset in this change.

Run `npx vitest run src/app/dispatch-otp src/plugins/sms`. Atomic integration tests require an explicitly
provided **disposable** Redis via `OTP_TEST_REDIS_PORT`; otherwise they are skipped. They delete only
their random dispatch keys. No shared cache instance is inferred.
