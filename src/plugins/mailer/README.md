# Mailer transports

`MAILER_TRANSPORT` selects `smtp`, `api`, or `log`. The log transport writes a structured
`mailer.delivery_attempt` entry with recipients, template, and outcome. Set
`MAILER_BOUNCE_EMAIL` to the recipient that should simulate a bounce; the default is
`bounce@example.test`.

The adapters return `sent`, `bounced`, or `failed`. Dispatch business logic handles a bounced
promise from the result returned by `MailerPort.send` and records the appropriate immutable
dispatch and batch events for coordinator follow-up. No email address is treated as customer
acceptance.

SMTP templates live in `templates/` and are copied into `dist/plugins/mailer/templates` by Nest's
asset configuration. Available template names are `promise`, `reminder`, `risk-notice`,
`delivery-maintained`, and `status-change`.

## Configuration by environment

Only names are listed here. **No value that is a secret (`SMTP_USER`, `SMTP_PASS`, `MAILER_API_KEY`)
belongs in the repository**: they come from the secret store of each environment, and `.env` files
stay out of git.

| Variable | Local development | Test / staging | Production |
|---|---|---|---|
| `MAILER_TRANSPORT` | `log` (writes `mailer.delivery_attempt`, sends nothing; no SMTP needed) | `smtp` against a sandbox inbox, or `log` | `smtp` or `api` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | not needed with `log` | the sandbox inbox's host and port; a sender that identifies the environment | the real relay; a sender on the company's own domain |
| `SMTP_USER`, `SMTP_PASS` | not needed | secret of the environment | secret of the environment |
| `MAILER_API_URL`, `MAILER_API_KEY`, `MAILER_FROM` | not needed | only with `MAILER_TRANSPORT=api` | only with `MAILER_TRANSPORT=api` |
| `MAILER_BOUNCE_EMAIL` | simulates a bounce with the `log` transport (default `bounce@example.test`) | idem | not used by `smtp`/`api` |
| `PUBLIC_WEB_URL` | `http://localhost:5173` (default) | the web portal of the environment | the public `https://` URL of the portal: the tracking link in every email is built from it |

A wrong `PUBLIC_WEB_URL` does not stop an email: it goes out with a link that does not open the
tracking page. The SMTP transport bounds how long a send can hang (`smtp.config.ts`: 10 s to connect,
10 s for the greeting, 30 s per command).

## Customer status change emails (ST-39.1, ST-39.2)

When a delivery changes to a status of the approved table (`customer-status-notices/domain/status-notice-table.ts`)
the customer gets one email, with the `status-change` template. It is **sent once per event and
recoverable**:

- Each email is a row of `customer_notifications` (database migration 029) with the idempotency
  key `status_change:<dispatchId>:<status>:<instant of the transition>`, which is unique: two
  deliveries of the same event leave one row and one send. The row also keeps the status, the
  normalized recipient, the template and its version, the attempts and the last error (sanitized:
  no address, link or token).
- A failed send is tried **3 times** right away (waits of 500 ms and 1 s, like the push retry). If
  the provider is still failing, the row stays `retrying` and the `customer-notification-recovery`
  task (every 5 minutes) tries again at **5 min, 15 min and 1 h**; after **6 attempts in all** the row
  is `exhausted` and nothing retries it. A `bounced` result (the provider refuses the recipient) is
  final and is never retried. The numbers are in `customer-status-notices/domain/delivery-policy.ts`.
- A provider that is down never reverts or delays the status change: the email runs after the
  transition committed and its failure is recorded, not thrown.
- If the process dies while sending, the row keeps a 10 minute lease; when it runs out, the recovery
  task sends it again. In that rare case an email that had already left can be sent twice. The lease
  is also the proof of ownership: a process that comes back after losing it cannot overwrite the
  result of the one that took the row over. The recovery task takes one row at a time, each right
  before sending it, so a slow provider cannot make the leases of the rest of the batch run out.
- The status change module and the recovery task log the dispatch id and the status only. The
  transports themselves (`smtp`, `api`, `log`) still log the provider's raw error and, for `log`,
  the recipients: do not rely on them to keep addresses out of the logs.

States of a row: `sending` (in flight, or waiting for its lease to run out), `retrying` (waiting for
its next attempt) and the final ones, `sent`, `bounced` and `exhausted`. To see what needs attention:

```sql
SELECT customer_notification_id, dispatch_id, dispatch_status, status, attempts, next_attempt_at, last_error
  FROM customer_notifications
 WHERE status IN ('retrying', 'exhausted', 'bounced')
 ORDER BY updated_at DESC;
```
