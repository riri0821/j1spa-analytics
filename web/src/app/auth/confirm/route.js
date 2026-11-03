import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Public route (allow-listed in proxy.js) - this is what the link in the
// password-reset email points at. Verifying the token here (server-side)
// establishes the session via cookies, then hands off to /reset-password
// already signed in - no client-side hash-fragment parsing needed.
export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  // Same-origin paths only. `${origin}${next}` with next="@evil.com" builds
  // https://app.example.com@evil.com - where the app's own host is parsed as
  // userinfo and the browser goes to evil.com - and a protocol-relative
  // "//evil.com" is the same trick. A path it is, or the default.
  const requested = searchParams.get("next");
  const next = requested && requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : "/reset-password";

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  const url = new URL("/login", origin);
  url.searchParams.set("error", "invalid_reset_link");
  return NextResponse.redirect(url);
}
