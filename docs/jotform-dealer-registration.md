# Jotform dealer-registration connection

This backend receives dealer-registration notifications for Jotform form
`252405795315055` and reconciles the form through Jotform's authenticated API.
The integration is disabled until its database migration and credentials are
configured.

## Implemented scope

1. Jotform sends a standard multipart webhook to
   `POST /integrations/jotform/webhooks`. The standard form-integration URL
   uses HTTP Basic credentials.
2. The endpoint authenticates before parsing, requires a bounded
   `Content-Length`, validates string form/submission IDs, commits an
   idempotent Postgres inbox record, and returns HTTP 202.
3. Queue processing fetches `GET /submission/{id}` using the server-held
   `APIKEY` header. Webhook answers are never trusted as canonical data.
4. The authenticated response must match the configured form/submission IDs
   and exact configured question IDs/types. Only normalized email, company,
   optional dealer number, vendor status/workflow status, vendor timestamps,
   and a one-way change digest are stored. Raw answers, address, phone,
   applicant name, applicant IP, API bodies, and credentials are not retained
   or logged.
5. Scheduled, overlapping API reconciliation repairs missed webhooks and
   captures later Jotform edits. It has a durable cursor and an explicit first
   import boundary. Each scan probes Jotform's own latest `updated_at` value as
   a fixed provider-clock frontier, walks that bounded window with a descending
   submission-ID keyset, and only commits the frontier after the final page.
   The next scan rewinds it by `JOTFORM_RECONCILIATION_LOOKBACK_MINUTES` before
   applying the strict lower timestamp filter.

A form submission is recorded as submitted registration data. The current
form does not provide an authoritative LG approval or dealer-number field.
Optional account provisioning now creates a restricted, invited dealer account
only when `JOTFORM_ONBOARDING_ENABLED=true` and a business-approved active
`JOTFORM_ONBOARDING_MANAGER_ID` is configured. It never modifies or links an
existing account by email. The original new registration is linked after secure
mailbox activation; training registration itself never grants dealer features.
See [verified onboarding](verified-onboarding.md) for the full API contract,
verification audit, ownership safeguards and unresolved policy approvals. The
stakeholder's CRM mapping, LG approval and dealer-number issuance remain
unimplemented until those contracts are defined.

## Registration-copy recipient placeholder

`JOTFORM_REGISTRATION_NOTIFICATION_EMAILS` is reserved as a blank comma-separated email list for recipients to be supplied later. It is configuration documentation only: no new sender consumes it, so setting it alone does not deliver copies. Existing Jotform/Zapier distribution remains unchanged until approved addresses and a delivery-routing integration are provided. The list does not assign account ownership or authorize training verification; see [verified onboarding](verified-onboarding.md).

## Production activation

1. Deploy the database migration before enabling the integration. Heroku runs
   this automatically through the `release` command in `Procfile`; on another
   host run:

   ```bash
   npm run db:deploy
   ```

2. Create a Jotform key with **Read Access** for runtime use. Set every required
   production variable:

   ```text
   JOTFORM_INTEGRATION_ENABLED=true
   JOTFORM_FORM_ID=252405795315055
   JOTFORM_API_KEY=<read-access-key>
   JOTFORM_WEBHOOK_SECRET=<32+-character-base64url-or-hex-secret>
   JOTFORM_API_BASE_URL=https://api.jotform.com
   JOTFORM_EMAIL_QID=13
   JOTFORM_COMPANY_QID=14
   JOTFORM_NAME_QID=4
   JOTFORM_RECONCILIATION_START_AT=YYYY-MM-DD HH:MM:SS
   OPERATIONS_WEBHOOK_URL=https://<monitored-operations-receiver>
   ```

   Use the EU or HIPAA API origin only when it matches the Jotform account.
   The three question IDs are explicit go-live inputs; enabled startup refuses
   to infer them. Leave `JOTFORM_DEALER_NUMBER_QID` blank because this form has
   no confirmed dealer-number field.

   `JOTFORM_RECONCILIATION_START_AT` is a deliberate backfill boundary. Jotform
   timestamps have no timezone suffix, so do not derive this value from the
   application server's local or UTC clock. Read the earliest intended
   submission's exact `updated_at` value from the selected Jotform API origin,
   subtract one vendor-clock second, and verify that a read-only API query
   returns that known record. The integration uses a strict `updated_at:gt`
   filter, which excludes a submission at the exact boundary. Do not silently
   set it to the beginning of form history.

3. Configure a 32+ character secret containing only ASCII letters, digits,
   underscore, or hyphen. Use the deployment platform's secret manager or a
   non-echoing credential prompt to set these temporary setup-only variables:

   ```text
   JOTFORM_WEBHOOK_ADMIN_API_KEY=<temporary-full-access-key>
   JOTFORM_WEBHOOK_PUBLIC_BASE_URL=https://api.example.com
   ```

   The public base URL must be an HTTPS origin with no path, query, credentials,
   or fragment. Then run the idempotent setup command without placing the key
   directly in shell history:

   ```bash
   npm run jotform:register-webhook
   ```

   The command first verifies the configured question IDs/types against
   `/form/{id}/questions`, then performs GET/POST/GET webhook verification. It
   adds the exact authenticated URL only when absent and re-lists before
   retrying any ambiguous POST so a lost response cannot create duplicate
   webhooks. It bounds response bodies, retries transient reads, honors
   `Retry-After`, and never prints credentials or the credential-bearing target
   URL. Remove the Full Access key after setup; application runtime uses only
   the Read Access key.

4. Set the ingress/proxy request-body limit to **2,500,000 bytes** for this
   endpoint and preserve `Authorization` and `Content-Length`. The application
   rejects missing, invalid, or oversized lengths before multipart parsing and
   also limits multipart fields/files.

5. Run the durable recovery command at least every ten minutes:

   ```bash
   npm run jotform:maintenance
   ```

   Treat a nonzero exit as an alert. `OPERATIONS_WEBHOOK_URL` is required by
   this backend in production. Unhealthy runs emit a cross-process
   deduplicated, PII-free alert for terminal rows, reconciliation failures,
   exhausted quota reserve, or an open provider circuit. Each payload has a
   stable `eventId` so the receiving system can also deduplicate a rare
   delivery-success/database-commit failure. Monitor that webhook and scheduler
   failures.

6. Inspect the PII-free status whenever needed. It includes counts plus at most
   25 recent terminal submission IDs, safe error codes, attempts, and error
   timestamps so an operator can select a record for replay without production
   SQL:

   ```bash
   npm run jotform:status
   ```

   Alert if the scheduled command has not run successfully within the expected
   interval or if `oldestPendingAt` continues to age.

## Failure and recovery behavior

- Webhook acceptance is committed before HTTP 202. Duplicate delivery only
  increments delivery metadata and re-enqueues safely.
- Queue rows, reconciliation scans, and outbound API calls use database leases.
  API calls are serialized across dynos so late responses cannot reopen a
  newer quota/circuit decision. Row writes are locked so a concurrent webhook
  generation cannot be lost.
- Network, timeout, authentication, rate-limit, and provider-server outages
  open a shared circuit. They do not consume an individual submission's retry
  budget. Work remains queued until the provider/credential issue clears.
- Jotform quota exhaustion is recognized for HTTP/envelope 429 and Jotform's
  documented 401/403 `API-Limit exceeded` response. Processing pauses through
  the documented daily reset window while retaining a configured reserve.
- A new submission may briefly return 404 and receives three bounded attempts.
  Per-submission malformed/oversized responses use bounded retries, then become
  `REJECTED` or `DEAD_LETTER` without blocking later records.
- Reconciliation isolates malformed submissions, advances past valid
  timestamps, checkpoints every page, heartbeats long pages, and resumes after
  interruption. An equal-time conflict is verified with a point fetch; a stale
  malformed list record cannot erase newer verified data.
- A specific terminal record can be deliberately replayed after its cause is
  corrected:

  ```bash
  npm run jotform:replay -- --submission-id <digits>
  ```

## Privacy deletion

Imported submissions use a stable `ownerUserId`, bound only after an operator verifies ownership. Mutable or shared email addresses do not establish ownership. See [release fix operations](release-fix-operations.md) for binding and erasure commands.

In-app deletion erases every stably owned row, including records under historical emails. If matching unowned rows exist, access closes and the request remains pending privacy verification. Rows owned by another account are protected. A per-submission privacy tombstone prevents replay from restoring erased fields; email locks serialize import, binding and erasure. A newly discovered unowned submission matching a completed deletion is retained for `PRIVACY_OWNERSHIP_REVIEW`, not automatically assigned or erased. The maintenance worker flags this queue for operations.

An authorized privacy operator must verify the source-system identity and complete outstanding imported-record review. Deleting data in Jotform itself and approving retention periods still require the company’s privacy process. Historical aliases that predate recorded email history require source-system review; the migration cannot reconstruct unknown identities.

## Secret rotation

1. Move the current value to `JOTFORM_WEBHOOK_PREVIOUS_SECRET`.
2. Deploy a new URL-safe `JOTFORM_WEBHOOK_SECRET`.
3. Run `npm run jotform:register-webhook` to add and verify the new
   credential-bearing URL.
4. Confirm new deliveries and scheduled reconciliation.
5. Remove the old webhook in Jotform, then clear the previous-secret variable.

Both current and previous secrets are accepted during the rotation window.

## Form mapping changes

The configured contracts are email `13` / `control_email`, company `14` /
`control_textbox`, and name `4` / `control_fullname`. The name is validated but
not retained. A future configured dealer-number field must be a
`control_textbox`. Missing IDs, repurposed question types, invalid timestamps,
and wrong form/submission IDs fail closed. Any form structure change therefore
requires an intentional mapping update and verification before deployment.

Official references: [webhook payload and 30-second timeout](https://www.jotform.com/help/245-how-to-send-submission-data-via-a-webhook/),
[REST API authentication, endpoints, and filters](https://api.jotform.com/docs/),
[API key permissions](https://www.jotform.com/help/253-how-to-create-a-jotform-api-key/),
[daily API limits](https://www.jotform.com/help/406-daily-api-call-limits/).
