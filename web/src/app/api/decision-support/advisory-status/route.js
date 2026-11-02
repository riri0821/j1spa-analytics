import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/requireOwner";

const VALID_TYPES = ["low_stock", "demand_spike", "overstock"];

// Sets (or, on an empty value, clears back to automatic) the owner's
// manual override of which advisory type shows for a SKU - takes
// priority over the rule engine's own evaluation in
// lib/decisionSupport.js, which still runs and is still shown, just
// outranked. See sql/supabase_add_advisory_overrides.sql.
export async function POST(request) {
  // Decision Support is an owner-only screen, so this has to check the role
  // and not just that someone is signed in - a staff session could
  // otherwise POST here directly and rewrite the owner's overrides.
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

  const productId = Number(body.product_id);
  const manualType = (body.manual_type ?? "").trim();

  if (!productId) {
    return NextResponse.json({ error: "product_id is required." }, { status: 400 });
  }
  if (manualType && !VALID_TYPES.includes(manualType)) {
    return NextResponse.json({ error: "Invalid advisory type." }, { status: 400 });
  }

  if (!manualType) {
    const { error } = await supabase.from("advisory_overrides").delete().eq("product_id", productId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, product_id: productId, manual_type: null });
  }

  const { error } = await supabase
    .from("advisory_overrides")
    .upsert({ product_id: productId, manual_type: manualType, updated_by: user.id, updated_at: new Date().toISOString() });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, product_id: productId, manual_type: manualType });
}
