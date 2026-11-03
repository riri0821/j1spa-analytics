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
  `sql/migrations/021_fix_profiles_role_escalation.sql`. The only write to
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
  supabase_add_*.sql,
  supabase_fix_*.sql          additive, safe-to-run-against-real-data migrations,
                               each mirrored into supabase_schema.sql
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
`sql/supabase_add_forecast_warm_cron.sql`. It calls `net.http_get()` against the
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
initial migration has also shipped as its own small, additive migration file
(`sql/supabase_add_*.sql`, `sql/supabase_fix_*.sql`) — safe to run against a live
database with real data, and kept in sync with `supabase_schema.sql` so a fresh setup
and an already-running one stay equivalent. Each file's header comment says what it
depends on, if anything; apply unapplied ones in that order via the Supabase SQL
Editor.

Multi-table writes (`confirm_sale`, `edit_sale`, `undo_sale`, `record_stock_movements`,
`record_service`, `undo_service`) are Postgres RPC functions — `security definer`,
row-locking, atomic — since PostgREST alone can't do a locking multi-statement
transaction in one call.
