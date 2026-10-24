# Release fix operations — September 28, 2026

These are local source changes, not a deployed production release. The customer-facing staff fulfillment process and training cancellation/rescheduling rules remain undecided and were not implemented. See the frontend `docs/RELEASE_FIXES_2026-09-28.md` for the audit disposition and validation evidence.

## Deployment order

1. Review both working trees and back up the target database. No production database was modified during implementation.
2. Install the locked backend dependencies, generate Prisma, and apply migrations before deploying the new backend. There are three September 28 migrations: account security/push, release integrity, and push-session revocation. They add tables/columns without deleting existing accounts. The older pending migrations must also be reviewed against the actual deployed schema.
3. Deploy the backend, check `/health/ready`, then publish the matching mobile builds. Root `/` remains liveness; readiness checks PostgreSQL and returns a generic 503 on failure.
4. Keep a previous application artifact and a verified pre-release database backup. Prefer rolling back application code while retaining these additive tables; restoring a database loses writes since the backup and requires an operational decision. Do not reset a production database.

An isolated rehearsal upgraded the first six migrations to all nine, retained an existing synthetic account, dumped the upgraded database, restored it to a separate database, and verified the account. This is evidence for the migration mechanics, not a backup or capacity test of the production database.

## First manager and invitations

For an empty installation, a database operator may create one recipient-bound first-manager invitation:

```sh
npm run invitations:create -- --bootstrap --role SALES_MANAGER --email <approved-manager-email> --expires-at <future-ISO-timestamp>
```

Bootstrap refuses an existing manager or an outstanding manager invitation. It does not create a password, sign anyone in, accept terms, or send the invitation. Deliver the one-time raw token through the approved company channel. Subsequent invitations use the existing `--manager-id` option. No demo seed or test account is needed in production. The business decision about who approves incoming dealer requests and how invitations are delivered is still pending.

## Imported-record privacy ownership

Imported Jotform records are not assigned to users merely because email strings match. After verifying source-record ownership independently, bind a record:

```sh
npm run privacy:link-submission -- --record-id <internal-record-id> --user-id <account-id> --expected-email <record-email> --verified-by <operator-id>
```

The command locks the account/record, checks the expected email, refuses erased records and another existing owner, and records the verification actor/time. This binding only controls data ownership; it does not approve dealer applications or change staff fulfillment rules.

Account deletion erases all owned records regardless of later email changes. Ambiguous unowned matches close app access and leave a pending privacy request; they are not silently erased or falsely marked complete. Complete privacy review and use the existing `privacy:process-deletion` command. Another owner's records remain untouched. Historical email aliases predating the implementation are not recoverable automatically and require a source-system audit.

For a verified, specifically identified record associated with an external deletion request (including an account that no longer exists):

```sh
npm run privacy:erase-submission -- --record-id <internal-record-id> --request-id <deletion-request-id> --expected-email <verified-request-email> --verified-by <operator-id>
```

Run this only after independently verifying that the requester owns that exact submission. The tool refuses another account's linked record or a changed email and preserves a per-record privacy tombstone. Then finish the deletion request using `privacy:process-deletion`. The tombstone prevents webhook/reconciliation replay from repopulating erased fields. New unowned imports matching a completed request enter `PRIVACY_OWNERSHIP_REVIEW`; a reused mailbox is not enough to authorize deletion. Jotform-side erasure and legal retention approval remain company responsibilities.

## Maintenance and monitoring

The `jotform` Procfile worker runs `npm run jotform:worker`, reusing the existing durable queue leases, reconciliation and deduplicated alert handling every ten minutes. The process is defined, **not enabled on the hosting account**. Provision that worker or schedule the existing one-shot `jotform:maintenance` command every ten minutes. Verify alerts with the approved `OPERATIONS_WEBHOOK_URL`. Monitor process availability, failed exits, reconciliation freshness, privacy-review requests and dead-letter records. HTTP database readiness alone does not establish integration health.

Production SMTP, verified sender/domain, Expo push credentials and actual iOS/Android delivery are still activation gates. Follow the account-security/push document. Logout revokes the presented token and removes push installations registered to that token; another login remains valid. Existing socket subscribers revalidate at expiry and at most every 30 seconds for revocations/status changes. Offline logout removes local access but cannot deliver a server revocation until a network request succeeds.

The current Socket.IO adapter and rate limits are process-local. Deploy one web process until a shared adapter/rate-limit design is configured and tested. Inbox query count no longer grows per conversation, and foreground polling repairs missed events, but polling does not establish multi-process realtime delivery. Run a load test against the approved expected launch volume.

## Repeatable checks

`npm run lint` is non-mutating. `npm run lint:fix` is explicit. CI runs lint, full types including scripts/tests, unit tests, build, dependency audit, migrations and real-database acceptance tests using a disposable PostgreSQL service.

To run the acceptance suite locally, point `DATABASE_URL` at a dedicated loopback database whose name ends in `_release_test`, apply migrations, set `RELEASE_TEST_DATABASE=true`, then run `npm run test:e2e -- --runInBand --watchman=false`. The suite refuses other destinations. It uses synthetic accounts, overrides email delivery, disables real push/Jotform, and cleans up its fixtures. An intentional database exception tests rollback; its logged 500 is expected when that test passes.
