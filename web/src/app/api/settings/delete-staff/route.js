import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/requireOwner";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { id } = body;
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (id === auth.user.id) {
    return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: target, error: fetchError } = await admin.from("profiles").select("role").eq("id", id).single();
  if (fetchError || !target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }
  if (target.role !== "staff") {
    return NextResponse.json({ error: "Only staff accounts can be deleted." }, { status: 400 });
  }

  // Reassign their sale/stock-movement history to null (read as "Former
  // staff" in the UI) before deleting - deleting the auth user would
  // otherwise fail on the foreign key, and silently orphaning history
  // without accounting for it would falsify past reports.
  const { count: saleCount } = await admin
    .from("sales")
    .update({ user_id: null })
    .eq("user_id", id)
    .select("*", { count: "exact", head: true });
  const { count: moveCount } = await admin
    .from("stock_movements")
    .update({ user_id: null })
    .eq("user_id", id)
    .select("*", { count: "exact", head: true });

  const { error: deleteError } = await admin.auth.admin.deleteUser(id);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 400 });

  return NextResponse.json({ ok: true, reassigned: (saleCount ?? 0) + (moveCount ?? 0) });
}
