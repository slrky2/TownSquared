# Hackachusetts — City Land

A Next.js community app for Lowell, MA. Application source is in `my-app/`.

## Deploy to Vercel

1. Import `slrky2/Hackachusetts` at https://vercel.com/new.
2. Set **Root Directory** to **`my-app`** and **Framework Preset** to **Next.js**.
3. Use **Node.js 22.x**. The committed `my-app/vercel.json` sets install to `npm ci` and build to `npm run build`. Leave Output Directory at the Next.js default; do not use `out` or static export, because the app needs server APIs and Clerk middleware.
4. Add environment variables from `my-app/.env.local.example` to the appropriate Vercel environments before deploying:
   - **Required:** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, from the same Clerk instance.
   - **Maps:** `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`; optionally `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`.
   - **Chatbot:** `ANTHROPIC_API_KEY`. Without it, the assistant responds with an unavailable message (503).
   - **Reports:** `DATABASE_URL` and `REPORTS_S3_*` for PostgreSQL and private object storage. Run migrations before deploying; see [reporting setup](my-app/docs/reporting-storage.md).
   - **City staff:** optionally `CITY_STAFF_EMAILS` (comma-separated verified emails).
5. Deploy. For a public production release, configure a production instance in Clerk for your deployed domain and enable the desired sign-in methods. Use Clerk development keys for previews. Restrict your Google Maps browser key to the deployed domains and enable Maps JavaScript API and Geocoding API.
6. Check `/`, `/sign-in`, `/map`, and `/chatbot`. Sign in and try posting a report and claiming a bounty. Redeploy after changing `NEXT_PUBLIC_*` values because they are embedded at build time.

Vercel's Git integration handles preview and production deployments. GitHub Actions runs lint, type checking, tests, and a production build; it does not deploy to GitHub Pages. No Vercel token is needed in GitHub Actions.

## Reporting storage

Reports, comments, votes, feed entries/reactions, and photo associations use PostgreSQL. Photos are uploaded directly to private S3-compatible storage and validated before publication. Reporting writes require Clerk sign-in. There is no in-memory fallback or automatic report seed.

Follow [the reporting setup guide](my-app/docs/reporting-storage.md) for local Docker services, migrations, bucket configuration, cleanup, and production deployment. Bounties, profiles, job history, and simulated wallets also use PostgreSQL; see [bounty persistence](my-app/docs/bounties-storage.md). Bounty photos share the private object store. These balances do not provide real payments. Community messages remain session-only.

## Local development

```sh
cd my-app
npm ci
cp .env.local.example .env.local
# Fill in Clerk keys and reporting variables; see the reporting setup guide.
docker compose up -d --wait
npm run db:migrate
npm run storage:setup:local
npm run dev
```

Use Node.js 22.x. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` before opening a pull request.
GitHub Actions runs these checks on pull requests, pushes to `main`, and merge queues. CI starts disposable PostgreSQL and object-storage services so the real concurrency and photo-upload tests also run; it does not require production secrets. Configure the `validate` status check as required in GitHub branch protection or a ruleset to block failing merges.

Dependabot checks npm dependencies in `my-app/` and GitHub Actions every Monday. Minor and patch npm updates share a PR; major npm upgrades are proposed separately. Updates require review and CI, and are not automatically merged. The configuration takes effect once `.github/dependabot.yml` reaches the default branch.
The chatbot's `data/Lowell.md` is explicitly bundled with its Node.js function.

See [the app guide](my-app/README.md) for the source layout.
