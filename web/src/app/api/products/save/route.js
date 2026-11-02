import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/requireOwner";

export async function POST(request) {
  // The Products screen is owner-only; without a role check a staff session
  // could create and edit catalog entries (including unit_cost) by posting
  // here directly.
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { user } = auth;

  const supabase = await createClient();

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const sku = (body.sku ?? "").trim().toUpperCase();
  const name = (body.name ?? "").trim();
  if (!sku || !name) {
    return NextResponse.json({ error: "SKU and name are required." }, { status: 400 });
  }

  const values = {
    sku,
    name,
    category: (body.category ?? "").trim() || "Uncategorized",
    supplier: (body.supplier ?? "").trim() || "Unknown",
    unit_cost: Number(body.unit_cost) || 0,
    unit_price: Number(body.unit_price) || 0,
    reorder_point: Number(body.reorder_point) || 0,
    is_active: !!body.is_active,
  };
  // brand has no field in this form anymore (replaced by supplier) - only
  // touch it if a caller still sends one, so saving here doesn't blow away
  // a product's existing brand. Omitted on insert, the column's own
  // 'Generic' default applies.
  if (body.brand !== undefined) {
    values.brand = (body.brand ?? "").trim() || "Generic";
  }

  if (body.product_id) {
    // Update. vehicle_compat is deliberately left out here, same as the
    // original app - it has no field in this form, so including it would
    // null out any existing value (e.g. from historical import) on save.
    const { error } = await supabase
      .from("products")
      .update(values)
      .eq("product_id", body.product_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, product_id: body.product_id, mode: "updated" });
  }

  const { data: dup } = await supabase.from("products").select("product_id").eq("sku", sku);
  if (dup && dup.length > 0) {
    return NextResponse.json({ error: `SKU ${sku} already exists.` }, { status: 409 });
  }

  const openingStock = Number(body.opening_stock) || 0;
  const { data: created, error: insertError } = await supabase
    .from("products")
    .insert({ ...values, stock_on_hand: openingStock, source_type: "Direct Sales Entry" })
    .select("product_id")
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 400 });

  if (openingStock) {
    const { error: movementError } = await supabase.from("stock_movements").insert({
      product_id: created.product_id,
      sku,
      movement_type: "adjustment",
      quantity: openingStock,
      balance_after: openingStock,
      user_id: user.id,
      reference: "opening",
      note: "opening stock",
    });
    if (movementError) {
      return NextResponse.json(
        { error: `Product created, but opening stock movement failed: ${movementError.message}` },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({ ok: true, product_id: created.product_id, mode: "created" });
}
