# Persistent reporting setup

Reports, comments, votes, report feed entries/reactions, and photo associations now use PostgreSQL. Images use a private S3-compatible bucket. Bounties and simulated wallets also use PostgreSQL; see [bounty persistence](bounties-storage.md). Community chat remains session-only.

## Local development

Use Node.js 22 and start Docker Desktop first. From `my-app/`:

```sh
npm ci
# Copy the template only if you do not already have .env.local.
# Otherwise merge the reporting variables below into the existing file.
cp .env.local.example .env.local
docker compose up -d --wait
npm run db:migrate
npm run storage:setup:local
npm run dev
```

Keep your existing matching Clerk keys and Maps configuration. Add these server-only variables to `.env.local` (these credentials are exclusively for the local containers):

```dotenv
DATABASE_URL=postgresql://civic:local-development-only@localhost:5432/civic
REPORTS_S3_BUCKET=civic-reports
REPORTS_S3_REGION=us-east-1
REPORTS_S3_ENDPOINT=http://localhost:9000
REPORTS_S3_FORCE_PATH_STYLE=true
REPORTS_S3_ACCESS_KEY_ID=civic-local
REPORTS_S3_SECRET_ACCESS_KEY=local-development-only
```

Data survives app restarts and `docker compose down` in named Docker volumes. `docker compose down -v` deletes local data. Storage console: http://localhost:9001. The browser must reach the configured storage endpoint; `localhost` works for a browser running on this machine.

The database starts empty. No fictional reports, votes, or announcements are automatically seeded. Previous in-memory reports cannot be recovered after the old process has stopped. Existing localStorage viewer IDs are ignored.

### Storage image pull errors

The local storage service uses [Silo](https://github.com/pgsty/silo), a maintained MinIO-compatible fork, pinned by release and multi-platform digest. It keeps the existing ports, credentials, and named data volume. Quay's original MinIO image returns `401 Unauthorized` for anonymous pulls; logging into that registry is not part of this setup.

If an earlier pull was interrupted, rerun `docker compose up -d --wait` with the updated Compose file. An accompanying `No such image: postgres:17` means PostgreSQL's pull did not finish; Compose will retry it. Do not delete volumes to resolve an image download problem.

## Production

1. Provision a managed PostgreSQL database with backups and TLS. Set `DATABASE_URL` to the provider's connection string (prefer its pooled runtime connection for serverless hosting). Do not disable certificate verification. Use a direct connection for migrations if the provider requires it.
2. Provision a private S3-compatible bucket supporting presigned POST uploads. Set `REPORTS_S3_BUCKET`, `REPORTS_S3_REGION`, and credentials; AWS IAM roles may replace explicit credentials. Set `REPORTS_S3_ENDPOINT` and `REPORTS_S3_FORCE_PATH_STYLE` only when required by the provider. The endpoint must be publicly reachable over HTTPS by residents' browsers. Do not use the local example credentials.
3. Grant the runtime identity `s3:PutObject` and `s3:GetObject` for `reports/staging/*`, `reports/photos/*`, `bounties/staging/*`, and `bounties/photos/*`. Give the cleanup identity `s3:DeleteObject` on those prefixes. Keep public bucket access disabled. Do not grant residents bucket credentials; the API signs a single staging key for five minutes.
4. Configure bucket CORS for exact app origins, method `POST`, and allowed headers `*`. Example for AWS (replace the origin):

```json
{
  "CORSRules": [{
    "AllowedOrigins": ["https://your-app.example"],
    "AllowedMethods": ["POST"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 300
  }]
}
```

5. Add a lifecycle rule expiring **only** `reports/staging/` and `bounties/staging/` after one day. Never apply this expiry to `reports/photos/` or `bounties/photos/`. Schedule `npm run photos:cleanup` hourly against the intended environment to remove expired unattached normalized objects and draft rows. This command never selects photos attached to reports or bounties.
6. Run `npm run db:migrate` once as a release step before deploying the application. Migrations are transactional and serialized using a database advisory lock; they do not run during builds or request handling. The current migration is additive. Future destructive migrations need an explicit rollback/data migration plan.
7. Deploy with production Clerk settings. Configure backups for both database and bucket and test a coordinated restore. Monitor reporting API failures and storage/database usage.

The app fails with a generic 503 if persistence is not configured or unavailable. It never silently falls back to volatile server memory. Photo configuration is only needed for reports with images.

## Data and upload flow

- Public reads use the Clerk session only to compute the viewer's vote/reaction state and `isMine`. All writes require a Clerk session. Caller-provided identity fields are rejected for reports/comments and ignored by vote/reaction handlers.
- Public author names are stable `neighbor_<number>` aliases held in PostgreSQL. Responses do not expose Clerk IDs.
- The browser resizes images to JPEG, obtains a signed upload, and POSTs image bytes directly to storage. The signed policy caps each image at 1.5 MB. Up to five photo IDs fit into a small report JSON request.
- A completion endpoint checks ownership and expiry, decodes actual JPEG pixels with a decompression limit, strips metadata, and writes an immutable normalized image under a separate key. Reusing a signed staging upload cannot alter the published photo.
- Report creation atomically attaches ready, unexpired, owned photo records. Another account cannot attach them; neither can a second report. Photos become publicly readable only after attachment through `/api/issues/photos/:photoId`.
- Upload authorization is capped at 20 photos per account per hour using a database lock, shared across instances. Broader anti-abuse limits and moderation are still follow-up production work.
- Feed posts are derived from reports, eliminating a second write that could fail independently. Existing seeded feed announcements are not included in the persistent feed.
- This first change preserves the existing all-report list contract. Pagination, moderation/deletion, report statuses, and broader write quotas remain follow-up work. Public photos have immutable cache headers; any later deletion feature must account for CDN/browser retention.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

The SQL integration suite runs the migration against embedded PostgreSQL (PGlite), including a disk-backed database close/reopen test. Storage operations are simulated for deterministic ownership, lifecycle, and image-validation tests; they do not claim to validate a deployed bucket's CORS/IAM configuration.

Manual deployment smoke test:

1. Sign in as account A and submit a report with a photo. Confirm it appears on the map/feed.
2. Comment, vote, and react from account B. Confirm account A sees the changes after refresh and ownership flags remain correct.
3. Restart/redeploy the app. Repeat from another browser/device; all submitted data and photos must still load.
4. Signed-out reads should work; writes must return 401. Attempting to attach another user's photo must fail.
5. Stop the database or storage temporarily; verify useful errors rather than success or replacement demo data.

References: [node-postgres transactions](https://node-postgres.com/features/transactions), [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html), [PGlite](https://pglite.dev/docs/).
