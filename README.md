# J1SPA: Data-Driven Business Analytics & Decision Support System

Web application for **J1 Scooter Parts and Accessories**: direct sales entry, stock-in,
product management, manual service records, an owner analytics dashboard, five-model
demand forecasting, and a rule-based decision-support layer — all behind one
role-gated interface (owner / staff).

Hosted on the public internet (Vercel + Supabase), reachable from anywhere, not just
on-site.

---

## 1. Stack

| Layer | Technology |
|---|---|
| Web app | Next.js 16 (App Router, plain JavaScript — not TypeScript, a deliberate Phase 0 choice) |
| Database + Auth | Supabase (Postgres, Row Level Security, Supabase Auth) |
| Hosting | Vercel, deploying `web/` as the project root |
| Forecasting | FastAPI (Python) microservice, `forecast-service/`, deployed separately on Render |
| Email | Resend (password-reset links) |

There is **no ETL/warehouse layer** — the dashboard, forecasting, and decision-support
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
(Postgres Row Level Security policies) — not just hidden in the UI.

### Creating accounts

There is deliberately **no code path that creates an owner.** `handle_new_user()`
always writes `role = 'staff'`, ignoring any role in the sign-up metadata — that
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
  self-service "update your own profile" policy also covered `role` — see
  `sql/migrations/030_fix_profiles_role_escalation.sql`. The only write to
  `profiles` in the whole app is `api/settings/toggle-user`, which uses the
  service-role client and bypasses RLS.

---

## 3. Project layout

```
web/                        the live application
  src/app/
    dashboard/               owner analytics: KPI tiles, Gross & Net sales chart,
                              Top 5 best-sellers, stock-by-category, product table
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
  src/lib/                   Supabase client/server/admin factories, dashboard
                              analytics, the decision-support rule engine, CSV helpers
  src/proxy.js               Next.js 16's renamed middleware.js - refreshes the auth
                              session and redirects signed-out/deactivated users on
                              every request

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

Only needed if you're changing forecasting logic — the deployed one on Render is what
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
request waits 30–50s for it to boot. That cold start, not the statistics, is the
biggest part of a slow "Run comparison" — the five-model fit itself is ~0.6s.

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

Unapplied right now: **`032_fix_batch_2.sql`**. `030_fix_profiles_role_escalation.sql`
and the hardening half of `031_fix_audit_batch_1.sql` are applied — see
[Creating accounts](#creating-accounts) for the manual owner promotion and the Auth
setting that goes with it.

Multi-table writes (`confirm_sale`, `edit_sale`, `undo_sale`, `record_stock_movements`,
`record_service`, `undo_service`) are Postgres RPC functions — `security definer`,
row-locking, atomic — since PostgREST alone can't do a locking multi-statement
transaction in one call.

---

## 6. Seed and simulated data

The database is **not** real shop data. Two generators produced what is in it, and
both tag their rows so they can be told apart from anything genuine.

| Where it came from | Period | Tag |
| --- | --- | --- |
| Seed sales + the ledger backfill | 1 Jan 2020, 08:35 → 30 Sep 2026, 17:50 | `stock_movements.note = 'seed-backfill'` |
| `simulate-recent-activity.mjs` | 8 Oct 2026 → the last run | `note = 'simulated'` on sales and movements; service id ranges in `web/scripts/simulated-ids.json` |
| Hand-entered test sales | 30 Sep (evening), 3–6 Oct 2026 | none — eight sales entered through the app, all outside 08:00–18:00 trading hours; one carries `note = 'a'` |

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

Then restore `products.stock_on_hand` from the `backup` schema, or recompute it from
the remaining ledger. Dropping the seed history as well means also deleting
`note = 'seed-backfill'` movements and the sales behind them — at which point you are
starting from an empty catalog, which is the honest way to begin with real data.

---

## 7. Known limitations

**The data is simulated.** Everything above. No figure on any screen describes a real
month of trading, and the dashboard should be read as a demonstration that the
pipeline works, not as a finding about the business.

**Gross margin is flat at ~25.93%.** The seed generator priced the catalog at a 35%
markup over cost — 559 of 577 products sit at exactly 1.35, the rest between 1.336
and 1.50 — so the margin is arithmetically pinned near 0.35 / 1.35 = 25.93%. Measured
over all 253,313 `sale_items`: ₱260,274,527.50 revenue against ₱192,793,516.01 cost,
a margin of **25.9269%**. The dashboard's trailing-90-day figure only lifts off it (to
~26.2%) where simulated services, which are labour with no recorded cost, are mixed
in. A real catalog varies by category, supplier and season; none of that variation
exists here, so the margin sparkline is near-flat by construction rather than because
the shop is unusually consistent. Read it as "the arithmetic works", not as a finding.

**Forecasting has a cold start.** The forecast microservice runs on Render's free
tier, which spins the instance down after about 15 minutes idle. The next request
then waits 30–50 s for the container to boot — far longer than the ~0.6 s the model
fitting itself takes. Two things hide it: a pg_cron ping every ~10 minutes
(`sql/migrations/025_add_forecast_warm_cron.sql`) and `/api/cron/warm-forecast`,
which `/forecasting` calls on mount so the boot overlaps with picking a SKU. Neither
is a guarantee — if both are off, the first "Run comparison" of the day is slow. A
paid instance removes the behaviour entirely.

