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

  const email = (body.email ?? "").trim().toLowerCase();
  const fullName = (body.name ?? "").trim();
  const password = body.password ?? "";

  if (!email || !fullName || password.length < 6) {
    return NextResponse.json({ error: "Email, name, and a 6+ char password are required." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, role: "staff" },
  });

  if (error) {
    const message = /already.*registered|already exists/i.test(error.message)
      ? "That email is already registered."
      : error.message;
    return NextResponse.json({ error: message }, { status: 409 });
  }

  return NextResponse.json({ ok: true, id: data.user.id });
}
