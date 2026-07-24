# AutoHalo

Migrates data between **Autotask** and **HaloPSA**, in either direction. A React /
Next.js rewrite of the original Laravel tool, running on **Vercel** with
**Supabase** for auth, data and the job queue.

## What it moves

Entities run in dependency order, so foreign keys always resolve:

| # | Entity | Autotask | HaloPSA |
|---|--------|----------|---------|
| 10 | Users / technicians | Resources | Agents |
| 20 | Customers | Companies | Clients |
| 25 | Sites | CompanyLocations | Sites |
| 30 | Contacts | Contacts | Users |
| 40 | Products | Products | Items |
| 50 | Contracts | Contracts | Client contracts |
| 60 | KB articles | KnowledgeBaseArticles | KB articles |
| 65 | Documentation | Documents | KB articles |
| 70 | Project templates | Projects (type = template) | Templates |
| 80 | Projects | Projects + Phases + Tasks | Project tickets + Milestones + child tickets |
| 90 | Opportunities | Opportunities | Opportunities |
| 100 | Tickets | Tickets + TicketNotes + TimeEntries | Tickets + Actions |
| 110 | Attachments | Attachments on all of the above | Attachments |

A project called "Migration" with tasks under it arrives in Halo as a project
called "Migration" with those same tasks under it. Time entries and notes ride
along with their ticket or task.

Reverse (Halo → Autotask) covers customers, sites, contacts, agents, tickets
with their history, projects, opportunities and KB articles.

## How it runs

Serverless functions cannot run for hours, so a migration is executed as a
sequence of time-boxed slices:

1. `POST /api/runs` creates the run, charges an entitlement, and queues one
   `run_tasks` row per selected entity.
2. Vercel Cron hits `/api/worker` every minute. The worker claims a run under a
   database lease, processes tasks in `seq` order until ~8s before its deadline,
   persists each entity's cursor, and releases the lease.
3. The next tick picks up exactly where the last one stopped.

Nothing is held in memory between invocations, so timeouts, cold starts and
redeploys are all survivable. Paging is keyset-based (`id > lastId`) rather than
offset-based, so records created mid-run cannot shift the window.

**Idempotency** comes from `id_map`, which records that source record X became
target record Y. Re-running a migration updates instead of duplicating, and a
content hash lets unchanged records be skipped entirely.

## Access, billing and admin

- **Login** — Supabase Auth (email + password).
- **Auto-provisioning** — a database trigger on `auth.users` creates the
  profile, an org named after the signup company, and an owner membership. No
  manual tenant setup.
- **One-time fee** — one Stripe purchase grants one `entitlements` row, claimed
  atomically when a live run starts. Dry runs are always free, so customers can
  validate before paying.
- **Admin override** — `profiles.is_platform_admin` bypasses billing entirely;
  `orgs.unlimited` does the same for a whole org; admins can also grant credits
  from `/admin`.

## Security

- Tenant Autotask/Halo credentials are sealed with **AES-256-GCM** before they
  reach the database. The key lives only in the server environment, and
  `key_version` on each row supports rotation without re-encrypting everything.
- Ciphertext columns are withheld from the `authenticated` role by a
  column-level grant, so even a bad RLS policy cannot leak them.
- **RLS on every table**, with `is_org_member` / `is_org_admin` helpers.
  Service-role code paths still filter by `org_id` explicitly.
- The Stripe webhook verifies signatures against the raw body and is idempotent
  via a primary key on the event id.
- `/api/worker` requires a bearer `CRON_SECRET`, compared in constant time.

## Setup

### 1. Supabase

Create a project, then run the SQL in order:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_init.sql
```

### 2. Environment

```bash
cp .env.example .env
npm run keygen   # prints CREDENTIAL_ENCRYPTION_KEY and CRON_SECRET
```

Fill in the Supabase URL, anon key and service-role key from
*Project Settings → API*.

> Keep `CREDENTIAL_ENCRYPTION_KEY` safe. Lose it and every stored connection
> becomes unreadable and must be re-entered.

### 3. Run

```bash
npm install
npm run dev
```

### 4. First admin

Sign up through the app, then edit the email at the top of
`supabase/migrations/0002_bootstrap_admin.sql` and run it:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/0002_bootstrap_admin.sql
```

### 5. Deploy

```bash
vercel --prod
```

Set the same environment variables in the Vercel project. `vercel.json` already
registers the cron. Cron requires a **Pro** plan for minute-level frequency; on
Hobby it falls back to daily, in which case rely on the worker ping that
`/api/runs` fires when a run starts, or trigger `/api/worker` externally.

### 6. Stripe (optional)

Create a one-off Price, then set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and
`STRIPE_WEBHOOK_SECRET`. Point a webhook at
`https://<your-domain>/api/stripe/webhook` for `checkout.session.completed`.

Leave Stripe unset to run purely on admin-granted credits.

## Connection credentials

**Autotask** — an API User (Admin → Resources) gives you a username, secret and
integration code. The zone URL is detected automatically from the username.

**HaloPSA** — Configuration → Integrations → Halo API → an application with
`Client ID and Secret` authentication and the `all` scope. You need the auth
URL, API base URL, client id, secret, and the tenant on hosted instances.

Both are verified before the connection is saved — a connection that has never
authenticated is worse than none, because it fails mid-migration instead of at
setup.

## Tuning a migration

Reference data (statuses, priorities, ticket types) is matched **by label**,
because the numeric ids differ between instances. `lib/migration/lookups.ts`
holds that logic and is the first place to adjust when a customer's naming does
not line up.

Halo endpoint names live in `lib/connectors/haloResources.ts` — one line each,
so a tenant with a differently-named endpoint is a one-line fix rather than a
hunt through the mappers.

Adding an entity means writing a handler and slotting it into the `seq` order in
`lib/migration/handlers/index.ts`. Nothing else needs to change.

## Project layout

```
app/
  (app)/          dashboard, connections, migrations, billing, admin
  api/
    worker/       cron-driven slice runner
    runs/         create, monitor, pause/resume/cancel/retry
    connections/  create + verify
    stripe/       checkout + webhook
    admin/        grant credits, toggle unlimited
lib/
  connectors/     Autotask + Halo clients, credential vault
  migration/
    engine.ts     claim, slice, checkpoint, finish
    handler.ts    the generic copy loop
    handlers/     one module per entity
    lookups.ts    label-based reference-data matching
    paging.ts     keyset paging
  crypto.ts       AES-256-GCM envelope encryption
  entitlements.ts billing gate
supabase/migrations/
```
