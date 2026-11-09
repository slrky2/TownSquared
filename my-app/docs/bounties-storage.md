# Persistent bounties

Bounty jobs, claims, approval state, public profiles, simulated wallets, wallet entries, and action history now live in PostgreSQL. The board starts empty; no fictional jobs or profiles are automatically inserted. New jobs appear on the board and map through the existing APIs. Photos use the same private bucket and validation pipeline as reports, under separate `bounties/` prefixes.

## Setup and deployment

Use the existing `DATABASE_URL` and `REPORTS_S3_*` settings from [reporting setup](reporting-storage.md). No new service or credentials are needed. From `my-app/`:

```sh
docker compose up -d --wait
npm run db:migrate
npm run storage:setup:local
npm run dev
```

`002_bounties.sql` adds the bounty tables without changing existing reports. The migration runner applies it once. Run migrations before deploying the new API/UI. The previous in-memory jobs and wallets are not imported; that volatile store cannot provide a reliable cross-instance migration source.

For a hosted bucket, extend the runtime identity's GetObject/PutObject permissions to `bounties/staging/*` and `bounties/photos/*`, and the cleanup identity's DeleteObject permissions to both prefixes. Add a one-day expiry rule for `bounties/staging/` only. Preserve published `bounties/photos/` objects. Local setup adds both report and bounty staging lifecycle rules automatically. CORS origins/methods are the same as reporting.

Schedule `npm run photos:cleanup` to remove expired unattached drafts for both features. It locks each draft before deletion, so attachment and cleanup cannot race. Published images are never selected.

## Behavior and invariants

- Public browsing remains available; writes derive the actor and staff role from Clerk on the server. Unknown identity fields and legacy inline image data are rejected.
- Each account receives the existing **simulated** $35 starting credit once. Returning to the app, restarting it, or deploying a second instance does not reset the wallet. This change does not implement real funding, withdrawals, refunds, or payment processing. City rewards still use the existing simulated city funding model.
- A normal job atomically deducts its reward from the poster's balance, creates a hold ledger entry, attaches its optional validated photo, and records its creation event. Failure rolls the whole transaction back. Concurrent posts cannot spend more than the available balance.
- Jobs follow `open → claimed → done → paid`. Row locks serialize competing claims and approvals. Only the worker marks a claimed job done; only the poster (city jobs: staff) approves. Approval atomically credits the worker, records one payout and event, and marks the job paid. Repeated or simultaneous approvals cannot credit the worker twice.
- Ledger amounts are integer cents. A unique opening entry prevents duplicate starting grants. Constraints prevent negative balances, invalid job states, or duplicate events/payouts.
- Public profile IDs are random and persisted separately from Clerk IDs. Counts are computed from the stored jobs. Display names refresh from the existing server-resolved Clerk actor.
- The form uploads one resized JPEG directly to storage and posts only its photo ID to the bounty API. Finalization checks actual image bytes, ownership and expiry; it strips metadata before publication. A photo can be attached to only one bounty, and report photos cannot be substituted.
- Drafts expire after one hour; signed uploads expire after five minutes. Authorization allows 20 uploads per account per hour per feature. Broader moderation, quotas, pagination, cancellation, and disputes remain separate follow-up work.

## Verification

The default `npm test` suite covers rules/ownership, balance and ledger correctness, rollback after write failures, photo attachment, authorization boundaries, and a disk-backed database close/reopen test. Default SQL tests use PGlite. The existing reporting tests also run to catch shared-upload regressions.

Optional real PostgreSQL concurrency tests use independent connections inside a generated temporary schema, and drop only that schema afterward:

```sh
# Use a LOCAL PostgreSQL connection string. This variable is server-only.
BOUNTY_TEST_DATABASE_URL=postgresql://civic:local-development-only@localhost:5432/civic \
  npm test -- lib/bounties/postgres.test.ts
```

To include the real signed-upload/finalization/attachment smoke test, also supply the local `REPORTS_S3_*` environment settings and `BOUNTY_TEST_STORAGE=1`. These optional tests do not load `.env.local` themselves. The storage smoke test removes only its generated test objects. Normal `npm test` skips these external-service tests.

Manual smoke test: sign in, post a job with a photo, claim it with another account, mark it done, then approve from the poster account. Refresh both devices and restart the app; the job state, photo, public profile, and balances must persist. The app should show an empty board instead of fictional jobs on a fresh database.
