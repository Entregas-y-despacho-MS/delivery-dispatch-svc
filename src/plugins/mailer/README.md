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
asset configuration. Available template names are `promise`, `reminder`, `risk-notice`, and
`delivery-maintained`.
