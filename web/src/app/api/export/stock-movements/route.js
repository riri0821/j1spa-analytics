import { requireOwner } from "@/lib/requireOwner";
import { createClient } from "@/lib/supabase/server";
import { toCsv, csvResponse } from "@/lib/csv";
import { addDays, isValidDate, manilaInstant } from "@/lib/grossNetRange";

const COLUMNS = [
  { key: "movement_id", label: "movement_id" },
  { key: "date", label: "date" },
  { key: "sku", label: "sku" },
  { key: "name", label: "name" },
  { key: "movement_type", label: "movement_type" },
  { key: "quantity", label: "quantity" },
  { key: "balance_after", label: "balance_after" },
  { key: "reference", label: "reference" },
  { key: "note", label: "note" },
];

export async function GET(request) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  // Validated, not just present: addDays() on a malformed date builds an
  // Invalid Date and throws on toISOString(), which would 500 the request
  // instead of saying what was wrong.
  if (!isValidDate(start) || !isValidDate(end)) {
    return Response.json({ error: "start and end are required (YYYY-MM-DD)." }, { status: 400 });
  }
  if (start > end) {
    return Response.json({ error: "start must not be after end." }, { status: 400 });
  }
  // Manila day bounds, not UTC ones. `${end}T00:00:00Z` put the window
  // eight hours out from every screen in the app, so a CSV for a given date
  // range quietly disagreed with the totals the Sales Tracker showed for the
  // same dates - the worst kind of reporting bug, because both look right.
  const startInstant = manilaInstant(start);
  const endExclusive = manilaInstant(addDays(end, 1));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stock_movements")
    .select("movement_id, movement_ts, sku, movement_type, quantity, balance_after, reference, note, products(name)")
    .gte("movement_ts", startInstant)
    .lt("movement_ts", endExclusive)
    // Chronological, by time rather than by id: the October gap fill gave
    // the earliest rows in this range the highest movement_ids, so ordering
    // by id put them last in a CSV that reads as a timeline.
    .order("movement_ts")
    .order("movement_id");

  if (error) return Response.json({ error: error.message }, { status: 400 });

  const rows = (data ?? []).map((r) => ({
    movement_id: r.movement_id,
    date: r.movement_ts,
    sku: r.sku,
    name: r.products?.name,
    movement_type: r.movement_type,
    quantity: r.quantity,
    balance_after: r.balance_after,
    reference: r.reference,
    note: r.note,
  }));

  const csv = toCsv(COLUMNS, rows);
  return csvResponse(`stock-movements-${start}-to-${end}.csv`, csv);
}
