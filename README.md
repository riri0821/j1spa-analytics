# J1SPA: Data-Driven Business Analytics & Decision Support System

Web application for **J1 Scooter Parts and Accessories**: direct sales entry, stock-in,
product management, manual service records, an owner analytics dashboard, five-model
demand forecasting, and a rule-based decision-support layer, all behind one
role-gated interface (owner / staff).

Hosted on the public internet (Vercel + Supabase), reachable from anywhere, not just
on-site.

---

## 1. Stack

| Layer | Technology |
|---|---|
| Web app | Next.js 16 (App Router, plain JavaScript, not TypeScript: a deliberate Phase 0 choice) |
| Database + Auth | Supabase (Postgres, Row Level Security, Supabase Auth) |
| Hosting | Vercel, deploying `web/` as the project root |
| Forecasting | FastAPI (Python) microservice, `forecast-service/`, deployed separately on Render |
| Email | Resend (password-reset links) |

There is **no ETL/warehouse layer**. The dashboard, forecasting, and decision-support
pages all read live from one operational Postgres schema (`sql/supabase_schema.sql`),
via SQL views (`vw_daily_sales`, `vw_monthly_sales`, `vw_product_velocity`) computed on
the fly rather than a separately-synced star schema.

---

## 2. Roles

* **owner** → full access: dashboard, forecasting, decision support, per-product
  stock ledgers, products, sales entry, stock-in, services, settings (staff
  account management).
* **staff** → sales entry + services only. No stock-in, cost, gross profit,
  analytics, forecasts, or advisories.

Enforced both at the page level (role check + redirect) and at the database level
(Postgres Row Level Security policies), not just hidden in the UI.

### Creating accounts

There is deliberately **no code path that creates an owner.** `handle_new_user()`
always writes `role = 'staff'`, ignoring any role in the sign-up metadata. That
metadata is supplied by whoever makes the sign-up request, so trusting it let a
single `/auth/v1/signup` call mint its own owner account. Promote the owner by hand,
once, in the Supabase SQL editor:

```sql
update profiles set role = 'owner' where username = 'you@example.com';
```

Two settings that matter:

* **"Allow new users to sign up" must be OFF** in Supabase → Authentication →
  Sign In / Providers. Staff accounts are created by the owner through `/settings`
  (service-role), which doesn't need public sign-up; leaving it on lets anyone
  create a working staff login against the project's anon key.
* `profiles` has **no update policy**. RLS has no column-level grain, so a
  self-service "update your own profile" policy also covered `role`. See
  `sql/migrations/030_fix_profiles_role_escalation.sql`. The only write to
  `profiles` in the whole app is `api/settings/toggle-user`, which uses the
  service-role client and bypasses RLS.

---

## 3. Project layout

```
web/                        the live application
  src/app/
    dashboard/               owner analytics. A hero card (gross profit margin with
                              a 90-day sparkline, total units in stock, critical
                              restocking count), Stock by Category as a donut with
                              the unit total in the centre and a "Show all
                              categories" list, the Gross & Net chart with a
                              calendar period picker (Day/Week/Month/Year), Top 5
                              best-selling parts, and the Tracking table (Balance
                              column, each SKU links to its ledger)
    forecasting/              5-model demand forecasting workspace (owner)
    decision-support/          low-stock / demand-spike / overstock advisories,
                                with owner-settable manual overrides per SKU
    ledger/[sku]/             per-product stock ledger (stock card): derived
                               opening balance, every stock movement, running
                               balance, date range in Manila time (owner)
    sales/                    Sales Entry, Services, Sales Tracker (owner + staff;
                               the tracker's peso totals are owner-only)
    stockin/                  Stock In + Stock-In Tracker (owner)
    products/                  product catalog management (owner)
    settings/                  staff account management (owner)
    login/, reset-password/, auth/confirm/
    api/                       server routes: CSV exports, the forecast-service
                                proxy, Supabase Admin-API actions, decision-support
                                override writes
  src/components/            shared across screens:
    CategoryProductPicker      category filter plus product search, used by Sales
                                Entry, Stock In and Products
    DateWindowPicker           the Day/Week/Month/Year period picker and its
                                calendar popover; the period lives in the URL
    PaginationControls         the count plus prev/next strip, with optional
                                First/Last, a page indicator and a jump box
    RowSizeSelect              rows-per-page (10/20/50), remembered per list
  src/lib/                   Supabase client/server/admin factories, plus:
    ledger.js                  builds a product's stock card: opening balance, one
                                row per movement, totals, and the paging maths
    grossNetRange.js           calendar period maths (day, Mon-Sun week, month,
                                year) in Manila time, shared by all three pickers
    alertsBatch.js             decides whether a Decision Support run differs from
                                the last one recorded, so `alerts` stops repeating
    pageSize.js                page size and page number for the paginated lists
    searchFilter.js            escapes user search text into PostgREST filters
    loginLockout.js            escalating login lockout and the password-reset quota
    decisionSupport.js         the rule engine: low stock, demand spike, overstock
    analytics.js               the dashboard's server-side figures
  src/proxy.js               Next.js 16's renamed middleware.js. Refreshes the auth
                              session, redirects signed-out and deactivated users,
                              and lets /api/* through to each route's own check
  scripts/                   node scripts, never bundled by Next:
    *.check.mjs                unit checks for the pure libraries, no database
                                needed: npm run check:ledger, check:gross-net,
                                check:backfill, check:alerts
    backfill-ledger.mjs        rebuilds every product's ledger chain backwards from
                                its stock_on_hand (run once, before the simulation)
    simulate-recent-activity.mjs  tops up sales/services from the last recorded
                                event to now, or fills an earlier window with
                                --from/--to
    cleanup-test-data.mjs      finds the hand-entered test rows and plans their
                                removal, recomputing every affected ledger chain
    simulated-ids.json         the id ranges each simulation run inserted

forecast-service/            FastAPI microservice: SMA / WMA / Linear Regression /
                              ARIMA / Holt-Winters, rolling backtest + model
                              selection, called over HTTP from web/'s
                              /api/forecast/[sku] route

sql/
  supabase_schema.sql         full schema (tables, RLS policies, RPC functions) -
                               source of truth for a from-scratch setup
  migrations/NNN_*.sql        every change since, numbered in the order it was
                               applied; each mirrored into supabase_schema.sql
```

---

## 4. Local development

### Web app

```bash
cd web
npm install
cp .env.local.example .env.local   # fill in from Supabase/Resend/Render - see that file
npm run dev
```

Open <http://localhost:3000>.

### Forecast service

Only needed if you're changing forecasting logic. The deployed one on Render is what
the web app calls by default.

```bash
cd forecast-service
python -m venv .venv
.venv\Scripts\activate              # or source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                # fill in Supabase service-role key + shared key
uvicorn main:app --reload
```

### Keeping the forecast service warm

Render's free tier spins the service down after ~15 minutes idle, and the next
request waits 30-50s for it to boot. That cold start, not the statistics, is the
biggest part of a slow "Run comparison"; the five-model fit itself is ~0.6s.

The service's `/health` endpoint is unauthenticated by design
(`forecast-service/main.py`), so anything that can make an HTTPS request can keep
the instance up - no key, no secret, no repository variable.

**The scheduler in use is pg_cron**, installed by
`sql/migrations/025_add_forecast_warm_cron.sql`. It calls `net.http_get()` against the
service's `/health` every 5 minutes from the Supabase database this project
already runs, with no third-party account in the loop:

```sql
select cron.schedule('keep-forecast-warm', '*/5 * * * *',
  $job$ select net.http_get('https://j1spa-dss.onrender.com/health') $job$);
```

Two other things also ping it:

* `/forecasting` calls `/api/cron/warm-forecast` when the owner opens the page, so
  the boot overlaps with them picking a SKU instead of with their first click.
  That route hits `/health` too, and authorizes either an owner session or a
  scheduler presenting `Authorization: Bearer $CRON_SECRET`.
* `.github/workflows/keep-forecast-warm.yml` pings `/health` **directly**, not
  through the Next.js route, on a `*/5` schedule. It is installed and works on
  `workflow_dispatch`, but GitHub queues scheduled runs on a best-effort basis and
  did not fire the schedule reliably - which is why pg_cron does the real work. It
  needs no secret; override the target with a repository variable
  `FORECAST_HEALTH_URL` only if the service moves.

Not Vercel Cron: the Hobby plan runs cron jobs at most once a day, which cannot
cover a 15-minute idle timeout.

Budget note: Render's free tier allows 750 instance-hours a month and keeping one
service always-on uses ~730 of them. Stop the ping when the service doesn't need to
be responsive - `select cron.unschedule('keep-forecast-warm');`, and disable the
GitHub workflow if it is enabled.

---

## 5. Database

`sql/supabase_schema.sql` is the full from-scratch schema. Every change since the
initial migration has also shipped as its own small, additive migration file, in
`sql/migrations/`, numbered in the order it was applied (`001_` first). They are safe
to run against a live database with real data, and are kept in sync with
`supabase_schema.sql` so a fresh setup and an already-running one stay equivalent.
Each file's header comment says what it depends on, if anything; apply unapplied ones
in number order via the Supabase SQL Editor.

Every migration through `032_fix_batch_2.sql` has been applied to the live database.
See [Creating accounts](#creating-accounts) for the manual owner promotion and the
Auth setting that goes with `030_fix_profiles_role_escalation.sql`.

Multi-table writes (`confirm_sale`, `edit_sale`, `undo_sale`, `record_stock_movements`,
`record_service`, `undo_service`) are Postgres RPC functions: `security definer`,
row-locking and atomic, because PostgREST alone can't do a locking multi-statement
transaction in one call.

---

## 6. Security

* **Role checks on every page and route.** Each owner-only page re-reads the
  caller's role server-side and redirects; every route under `src/app/api/`
  calls `requireOwner()` (ten of them) or does the same two checks inline
  (`api/forecast/[sku]`), except `api/cron/warm-forecast`, which authorizes
  against `CRON_SECRET` or an owner session, and the two auth routes, which are
  public by design.
* **Login is server-side.** `api/auth/login` is the only place a password is
  checked, so the escalating lockout cannot be skipped by the browser: 3 failed
  attempts lock the account for 30s, and a repeat within five minutes moves up a
  ladder of 30s, 5min, 15min, 30min, 1hr, held in the `login_lockouts` table.
* **Password reset is rate limited.** Three requests per address and ten per IP
  per hour, counted in the same table, consumed before the account lookup so the
  limiter cannot be used to probe which addresses exist. The response is the same
  constant message either way.
* **No public sign-up, no self-service profile updates.** `handle_new_user()`
  always writes `role = 'staff'`, and `profiles` has no update policy at all:
  RLS has no column-level grain, so "update your own row" also covered `role`
  (`030_fix_profiles_role_escalation.sql`).
* **Anonymous access revoked.** All three reporting views run with
  `security_invoker = true` so the underlying RLS applies, and `anon` holds no
  privilege on them; `execute` on every function in `public` is revoked from
  `anon` and `PUBLIC` and granted only to `authenticated` and `service_role`,
  with default privileges set so the next function added inherits that
  (`031_fix_audit_batch_1.sql`).
* **Security headers.** `next.config.mjs` sends `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'` and a `Permissions-Policy`
  on every path, and `poweredByHeader: false` drops `X-Powered-By`.
* **Non-negative product figures.** `products` carries check constraints on
  `unit_cost`, `unit_price`, `reorder_point` and `stock_on_hand`
  (`031_fix_audit_batch_1.sql`), with `api/products/save` rejecting negatives
  with a 400 before they get that far.

Known gap: cost and gross-profit columns are hidden by the UI but not yet by the
database. See the note in [Roles](#2-roles).

---

## 7. Seed and simulated data

The database is **not** real shop data. Two generators produced what is in it, and
both tag their rows so they can be told apart from anything genuine.

| Where it came from | Period | Tag |
| --- | --- | --- |
| Seed sales + the ledger backfill | 1 Jan 2020, 08:35 → 30 Sep 2026, 17:50 | `stock_movements.note = 'seed-backfill'` |
| `simulate-recent-activity.mjs` | 8 Oct 2026 → the last run | `note = 'simulated'` on sales and movements; service id ranges in `web/scripts/simulated-ids.json` |
| Hand-entered test sales | 30 Sep (evening), 3-6 Oct 2026 | none. Ten sales entered through the app, all outside 08:00-18:00 trading hours. One carries `note = 'a'` |

`web/scripts/simulated-ids.json` records every simulation run: the window it covered
and the exact `sales` / `services` id ranges it inserted, plus a `howToRemove` list.

### Topping it up

The simulation fills the gap between the latest recorded sale or service and now, so
running it again adds only the days since the last run. It never writes a future
timestamp.

```bash
cd web
node scripts/simulate-recent-activity.mjs            # dry run - prints the whole plan, writes nothing
node scripts/simulate-recent-activity.mjs --apply    # write it
```

The dry run is the default and prints the full plan: daily volume against the seed,
stockout rate, ending stock, low-stock share and gross margin. Read it before
applying. On `--apply` the inserted id ranges are appended to `simulated-ids.json`.

It must run **after** `scripts/backfill-ledger.mjs --apply`, which anchors every
product's ledger on `products.stock_on_hand`; the simulation then moves that figure.

### Removing it before real use

`simulated-ids.json` carries this list; in short:

```sql
delete from stock_movements where note = 'simulated';
delete from sale_items where sale_id in (select sale_id from sales where note = 'simulated');
delete from sales where note = 'simulated';
-- services have no note column - use the id ranges from runs[] in simulated-ids.json
delete from services where service_id between <first> and <last>;
```

`web/scripts/cleanup-test-data.mjs` does the same job for the hand-entered test rows,
which carry no tag at all: it finds them, recomputes every affected ledger chain and
prints the backup SQL to run first (dry run by default).

Then restore `products.stock_on_hand` from the `backup` schema, or recompute it from
the remaining ledger. Dropping the seed history as well means also deleting
`note = 'seed-backfill'` movements and the sales behind them, at which point you are
starting from an empty catalog. That is the honest way to begin with real data.

---

## 8. Known limitations

**The data is simulated.** Everything above. No figure on any screen describes a real
month of trading, and the dashboard should be read as a demonstration that the
pipeline works, not as a finding about the business.

**Gross margin is flat at ~25.93%.** The seed generator priced the catalog at a 35%
markup over cost (559 of 577 products sit at exactly 1.35, the rest between 1.336
and 1.50), so the margin is arithmetically pinned near 0.35 / 1.35 = 25.93%. Measured
over all 253,313 `sale_items`: ₱260,274,527.50 revenue against ₱192,793,516.01 cost,
a margin of **25.9269%**. The dashboard's trailing-90-day figure only lifts off it (to
~26.2%) where simulated services, which are labour with no recorded cost, are mixed
in. A real catalog varies by category, supplier and season; none of that variation
exists here, so the margin sparkline is near-flat by construction rather than because
the shop is unusually consistent. Read it as "the arithmetic works", not as a finding.

**Forecasting has a cold start.** The forecast microservice runs on Render's free
tier, which spins the instance down after about 15 minutes idle. The next request
then waits 30-50s for the container to boot, far longer than the ~0.6s the model
fitting itself takes. Two things hide it: a pg_cron ping every ~10 minutes
(`sql/migrations/025_add_forecast_warm_cron.sql`) and `/api/cron/warm-forecast`,
which `/forecasting` calls on mount so the boot overlaps with picking a SKU. Neither
is a guarantee. If both are off, the first "Run comparison" of the day is slow. A
paid instance removes the behaviour entirely.

