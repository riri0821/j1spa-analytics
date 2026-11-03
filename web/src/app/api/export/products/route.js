import { requireOwner } from "@/lib/requireOwner";
import { createAdminClient } from "@/lib/supabase/admin";
import { toCsv, csvResponse } from "@/lib/csv";

const COLUMNS = [
  { key: "sku", label: "sku" },
  { key: "name", label: "name" },
  { key: "category", label: "category" },
  { key: "brand", label: "brand" },
  { key: "supplier", label: "supplier" },
  { key: "unit_cost", label: "unit_cost" },
  { key: "unit_price", label: "unit_price" },
  { key: "reorder_point", label: "reorder_point" },
  { key: "stock_on_hand", label: "stock_on_hand" },
  { key: "is_active", label: "is_active" },
];

// Snapshot, not a date range - the catalog has no time dimension worth
// filtering on (unlike sales/stock movements), so this just exports
// everything as of right now.
export async function GET() {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  // Service-role, not the caller's session: this exports cost columns, and
  // migration 034 revokes those from `authenticated` - which an owner's
  // session is too. requireOwner() above is the gate; this is server-side
  // only and the key never leaves it.
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("products")
    .select("sku, name, category, brand, supplier, unit_cost, unit_price, reorder_point, stock_on_hand, is_active")
    .order("name");

  if (error) return Response.json({ error: error.message }, { status: 400 });

  const csv = toCsv(COLUMNS, data ?? []);
  return csvResponse(`products-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}
