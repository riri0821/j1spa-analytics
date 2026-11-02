import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buildLedger, formatManilaDate, manilaDayStart, parseDateParam } from "@/lib/ledger";
import { theme, CATEGORICAL, DELTA_DOWN, DELTA_UP } from "../../dashboard/theme";
import Sidebar from "../../dashboard/Sidebar";
import Card from "../../dashboard/Card";
import LedgerDateFilter from "./LedgerDateFilter";

// PostgREST caps a response at 1000 rows, so a long-lived product's history
// has to be paged through - a single select would silently stop at the cap
// and every balance below it would be wrong.
const PAGE_SIZE = 1000;

async function fetchAllMovements(supabase, productId) {
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("stock_movements")
      .select("movement_id, movement_ts, movement_type, quantity, balance_after, reference, note, supplier, user_id")
      .eq("product_id", productId)
      .order("movement_ts", { ascending: true })
      .order("movement_id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`stock_movements read failed: ${error.message}`);

    all.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return all;
  }
}

function peso(n) {
  return `₱${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function LedgerPage({ params, searchParams }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "owner") redirect("/sales");

  const { sku: skuParam } = await params;
  const query = await searchParams;
  const from = parseDateParam(query.from);
  const to = parseDateParam(query.to);

  // SKUs are stored upper-case, but a hand-typed or older link can arrive in
  // any case. The escape keeps a SKU containing % or _ from being read as a
  // LIKE wildcard and matching a different product.
  const requestedSku = decodeURIComponent(skuParam);
  const { data: product } = await supabase
    .from("products")
    .select("product_id, sku, name, category, brand, supplier, unit_price, reorder_point, stock_on_hand, created_at")
    .ilike("sku", requestedSku.replace(/[\\%_]/g, (c) => `\\${c}`))
    .maybeSingle();

  if (!product) {
    return (
      <Shell fullName={profile.full_name} role={profile.role}>
        <Card title="Product not found" subtitle={`No product matches SKU "${requestedSku}".`}>
          <a href="/dashboard" className="text-sm" style={{ color: CATEGORICAL[0] }}>
            ← Back to dashboard
          </a>
        </Card>
      </Shell>
    );
  }

  const movements = await fetchAllMovements(supabase, product.product_id);

  const userIds = [...new Set(movements.map((m) => m.user_id).filter(Boolean))];
  const { data: staff } = userIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", userIds)
    : { data: [] };
  const names = new Map((staff ?? []).map((s) => [s.id, s.full_name]));

  const ledger = buildLedger({ product, movements, from, to, names });

  // Only meaningful for an open-ended period: with a "To" date the ledger
  // stops before today's movements, so a mismatch there is expected.
  const balanceMismatch = !to && ledger.endingBalance !== product.stock_on_hand;

  const forecastHref = `/forecasting?sku=${encodeURIComponent(product.sku)}`;

  return (
    <Shell fullName={profile.full_name} role={profile.role}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <a href="/dashboard" className="text-xs" style={{ color: CATEGORICAL[0] }}>
            ← Back to dashboard
          </a>
          <h1 className="mt-1 text-xl font-semibold" style={{ color: theme.textPrimary }}>
            Stock Ledger · <span className="font-mono">{product.sku}</span>
          </h1>
          <p className="text-sm" style={{ color: theme.textMuted }}>
            {product.name}
          </p>
        </div>
        <a
          href={forecastHref}
          className="rounded px-4 py-1.5 text-sm font-medium"
          style={{ backgroundColor: theme.accent, color: "#05230f" }}
        >
          View demand forecast
        </a>
      </div>

      <div className="mb-4">
        <Card title="Item details">
          <dl className="grid gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <Detail label="Category" value={product.category} />
            <Detail label="Brand" value={product.brand} />
            <Detail label="Supplier" value={product.supplier} />
            <Detail label="Unit price" value={peso(product.unit_price)} numeric />
            <Detail label="Stock on hand" value={product.stock_on_hand} numeric />
            <Detail label="Reorder point" value={product.reorder_point} numeric />
          </dl>
        </Card>
      </div>

      <Card
        title="Ledger"
        subtitle={
          from || to
            ? `Movements from ${from ? formatManilaDate(manilaDayStart(from)) : "the beginning"} to ${to ? formatManilaDate(manilaDayStart(to)) : "today"}`
            : "Every movement recorded for this item"
        }
        actions={<LedgerDateFilter sku={product.sku} from={from} to={to} />}
      >
        <div className="flex flex-col gap-3">
          {balanceMismatch && (
            <p
              className="rounded border px-3 py-2 text-xs"
              style={{ borderColor: "#fab21955", backgroundColor: "#fab21916", color: "#fab219" }}
            >
              Ledger balance ({ledger.endingBalance}) does not match current stock on hand (
              {product.stock_on_hand}).
            </p>
          )}

          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: theme.border }}>
            <table className="w-full text-left text-sm">
              <thead>
                <tr style={{ color: theme.textMuted }}>
                  <th className="px-3 py-2 font-normal">Date</th>
                  <th className="px-3 py-2 font-normal">Particulars</th>
                  <th className="px-3 py-2 font-normal">Supplier</th>
                  <th className="px-3 py-2 text-right font-normal">IN (DR)</th>
                  <th className="px-3 py-2 text-right font-normal">OUT (CR)</th>
                  <th className="px-3 py-2 text-right font-normal">Balance</th>
                  <th className="px-3 py-2 font-normal">Recorded by</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t" style={{ borderColor: theme.border }}>
                  <td className="px-3 py-2" style={{ color: theme.textSecondary }}>
                    {ledger.beginningDateLabel}
                  </td>
                  <td className="px-3 py-2 font-medium" style={{ color: theme.textPrimary }}>
                    Beginning balance
                  </td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right font-medium tabular-nums" style={{ color: theme.textPrimary }}>
                    {ledger.beginningBalance}
                  </td>
                  <td className="px-3 py-2" />
                </tr>

                {ledger.rows.map((r) => (
                  <tr key={r.movementId} className="border-t" style={{ borderColor: theme.border }}>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: theme.textSecondary }}>
                      {r.dateLabel}
                    </td>
                    <td className="px-3 py-2" style={{ color: theme.textPrimary }}>
                      {r.particulars}
                    </td>
                    <td className="px-3 py-2" style={{ color: theme.textSecondary }}>
                      {r.supplier}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: DELTA_UP }}>
                      {r.quantityIn ?? ""}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: DELTA_DOWN }}>
                      {r.quantityOut ?? ""}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: theme.textPrimary }}>
                      {r.balance}
                    </td>
                    <td className="px-3 py-2" style={{ color: theme.textSecondary }}>
                      {r.recordedBy}
                    </td>
                  </tr>
                ))}

                <tr className="border-t" style={{ borderColor: theme.border, backgroundColor: theme.cardBgAlt }}>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 font-medium" style={{ color: theme.textPrimary }}>
                    Total transactions as of {ledger.asOfLabel}
                  </td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right font-medium tabular-nums" style={{ color: DELTA_UP }}>
                    {ledger.totalIn}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums" style={{ color: DELTA_DOWN }}>
                    {ledger.totalOut}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums" style={{ color: theme.textPrimary }}>
                    {ledger.endingBalance}
                  </td>
                  <td className="px-3 py-2" />
                </tr>
              </tbody>
            </table>
          </div>

          {ledger.rows.length === 0 && (
            <p className="text-xs" style={{ color: theme.textMuted }}>
              No transactions in this period.
            </p>
          )}
        </div>
      </Card>
    </Shell>
  );
}

function Detail({ label, value, numeric }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: theme.textMuted }}>
        {label}
      </dt>
      <dd className={numeric ? "tabular-nums" : ""} style={{ color: theme.textPrimary }}>
        {value}
      </dd>
    </div>
  );
}

function Shell({ fullName, role, children }) {
  return (
    <div
      className="flex flex-col md:flex-row h-screen overflow-hidden font-sans"
      style={{ backgroundColor: theme.pageBg }}
    >
      <Sidebar active="dashboard" fullName={fullName} role={role} />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">{children}</main>
    </div>
  );
}
