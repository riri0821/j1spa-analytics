import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/requireOwner";

export async function POST(request) {
  // Owner-only: this deletes or deactivates catalog rows, which the
  // Products screen (itself owner-gated) is the only UI for.
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  const supabase = await createClient();

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const productId = Number(body.product_id);
  if (!productId) {
    return NextResponse.json({ error: "product_id is required." }, { status: 400 });
  }

  const { data: product } = await supabase
    .from("products")
    .select("sku")
    .eq("product_id", productId)
    .single();
  if (!product) {
    return NextResponse.json({ error: "Product not found." }, { status: 404 });
  }

  // A product with recorded sales, stock movements, or alerts can't be
  // hard-deleted without breaking that history, so it's deactivated
  // (hidden from active lists) instead - same rule as the original app.
  // One named column each, not select("*"): a star asks for every column,
  // and migration 034 revokes select on sale_items.unit_cost / line_cost
  // from `authenticated`, which would turn these counts into errors.
  const [{ count: saleCount }, { count: movementCount }, { count: alertCount }] = await Promise.all([
    supabase.from("sale_items").select("sale_item_id", { count: "exact", head: true }).eq("product_id", productId),
    supabase.from("stock_movements").select("movement_id", { count: "exact", head: true }).eq("product_id", productId),
    supabase.from("alerts").select("alert_id", { count: "exact", head: true }).eq("product_id", productId),
  ]);

  if (saleCount || movementCount || alertCount) {
    const { error } = await supabase
      .from("products")
      .update({ is_active: false })
      .eq("product_id", productId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({
      ok: true,
      mode: "deactivated",
      product_id: productId,
      message: `${product.sku} has recorded sales/stock history, so it was deactivated instead of deleted.`,
    });
  }

  const { error } = await supabase.from("products").delete().eq("product_id", productId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, mode: "deleted", product_id: productId, message: `${product.sku} deleted.` });
}
