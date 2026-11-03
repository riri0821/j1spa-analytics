import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/requireOwner";
import { createClient } from "@/lib/supabase/server";

// Narrow, single-field update - deliberately separate from /api/products/save,
// which rewrites the whole product record (category/brand/supplier/etc) and
// would blank those out if called with only the fields an advisory card has
// on hand. Lets the owner correct a reorder point straight from Decision
// Support, without round-tripping through the full product edit form.
export async function POST(request) {
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
  const reorderPoint = Number(body.reorder_point);

  if (!productId) {
    return NextResponse.json({ error: "product_id is required." }, { status: 400 });
  }
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
    return NextResponse.json({ error: "Reorder point must be a whole number, 0 or greater." }, { status: 400 });
  }

  const { error } = await supabase
    .from("products")
    .update({ reorder_point: reorderPoint })
    .eq("product_id", productId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, product_id: productId, reorder_point: reorderPoint });
}
