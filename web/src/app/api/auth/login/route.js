import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkLockout, recordFailure, recordSuccess } from "@/lib/loginLockout";

// Public route (allow-listed in proxy.js) - the ONLY place a password is
// checked. The password check and the lockout bookkeeping have to happen in
// the same server-side request: when the browser called
// signInWithPassword() itself, the lockout was advisory only (skip the
// guard call and brute-force Supabase Auth directly with the anon key),
// and a client-supplied "success" could clear the failure counter without
// ever presenting a valid password.
export async function POST(request) {
  let email, password;
  try {
    ({ email, password } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const identifier = email.trim().toLowerCase();
  if (!identifier || !password) {
    return NextResponse.json({ error: "Enter an email and password." }, { status: 400 });
  }

  const admin = createAdminClient();

  const lock = await checkLockout(admin, identifier);
  if (lock.locked) {
    return NextResponse.json({ error: lock.message, locked: true }, { status: 429 });
  }

  // Cookie-writing SSR client, so a successful sign-in lands the session on
  // the response for proxy.js to pick up on the next request.
  const supabase = await createClient();
  const { data, error: signInError } = await supabase.auth.signInWithPassword({
    email: identifier,
    password,
  });

  if (signInError) {
    const fail = await recordFailure(admin, identifier);
    const message = fail.locked
      ? fail.message
      : `Invalid email or password. ${fail.attemptsRemaining} attempt${
          fail.attemptsRemaining === 1 ? "" : "s"
        } remaining before lockout.`;
    return NextResponse.json({ error: message, locked: fail.locked }, { status: fail.locked ? 429 : 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", data.user.id)
    .single();

  // Anything past this point is a valid password, so the failure counter is
  // cleared even when the account itself turns out to be unusable - the
  // lockout exists to stop password guessing, not to punish a valid login.
  await recordSuccess(admin, identifier);

  if (profileError || !profile) {
    await supabase.auth.signOut();
    return NextResponse.json(
      { error: "Signed in, but no profile row was found for this account." },
      { status: 403 }
    );
  }

  if (!profile.is_active) {
    await supabase.auth.signOut();
    return NextResponse.json(
      { error: "This account has been deactivated. Contact the owner." },
      { status: 403 }
    );
  }

  return NextResponse.json({ redirectTo: profile.role === "owner" ? "/dashboard" : "/sales" });
}
